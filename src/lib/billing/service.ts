import type { Payment, PaymentCustomer, PaymentMethod, PricingConfig, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { coreEnv } from "@/lib/env";
import { AppError, notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { queueAdminAlert } from "@/lib/email";
import { createLogger, errorFields } from "@/lib/logger";
import { isUniqueConstraintError } from "@/lib/prisma-errors";
import { paymentsConfigured, requirePaymentConfig } from "./config";
import { StripeProvider, summarizeRefund, type StripeIntentSummary } from "./stripe";
import {
  canReplayCharge,
  chargeIdempotencyKey,
  computeCampaignQuote,
  computePlanQuote,
  DEFAULT_PRICING,
  inFlightPaymentAction,
  invoiceNumber,
  nextBillingDate,
  nextRetryAt,
  paymentStatusFromIntent,
  type Pricing,
  type Quote,
} from "./pricing";

const log = createLogger("billing");

/**
 * Billing service. Two money flows are kept strictly apart:
 *   · PLATFORM service payments (this file) — charged through Stripe
 *   · META advertising spend — billed by Meta to the ad account; never touched here
 *
 * Exactly-once guarantees: Payment.idempotencyKey is unique and doubles as the
 * provider idempotency key; webhook events are unique on the provider event id.
 */

export function provider(): StripeProvider {
  return new StripeProvider(requirePaymentConfig().secretKey);
}

// ---- pricing ----

export function toPricing(row: PricingConfig | null): Pricing {
  if (!row) return DEFAULT_PRICING;
  return {
    currency: row.currency,
    campaignFeeCents: row.campaignFeeCents,
    campaignFeePercent: row.campaignFeePercent,
    planName: row.planName,
    planAmountCents: row.planAmountCents,
    planIntervalDays: row.planIntervalDays,
    taxPercent: row.taxPercent,
  };
}

export async function getPricing(): Promise<Pricing> {
  const row = await prisma.pricingConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
  return toPricing(row);
}

// ---- customers ----

export async function ensureCustomer(admin: { id: string; email: string | null; name: string }): Promise<PaymentCustomer> {
  const existing = await prisma.paymentCustomer.findUnique({ where: { adminId: admin.id } });
  if (existing) return existing;
  const pricing = await getPricing();
  const providerCustomerId = await provider().createCustomer({ email: admin.email, name: admin.name, adminId: admin.id });
  return prisma.paymentCustomer.create({
    data: { adminId: admin.id, provider: "stripe", providerCustomerId, email: admin.email, currency: pricing.currency },
  });
}

export async function findCustomer(adminId: string): Promise<PaymentCustomer | null> {
  return prisma.paymentCustomer.findUnique({ where: { adminId } });
}

// ---- payment methods (display metadata only) ----

export async function refreshPaymentMethods(customer: PaymentCustomer): Promise<PaymentMethod[]> {
  const cards = await provider().listCards(customer.providerCustomerId);
  const seen = new Set<string>();
  for (const card of cards) {
    seen.add(card.id);
    await prisma.paymentMethod.upsert({
      where: { providerMethodId: card.id },
      create: { customerId: customer.id, providerMethodId: card.id, brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear },
      update: { brand: card.brand, last4: card.last4, expMonth: card.expMonth, expYear: card.expYear, removedAt: null },
    });
  }
  await prisma.paymentMethod.updateMany({
    where: { customerId: customer.id, removedAt: null, providerMethodId: { notIn: [...seen] } },
    data: { removedAt: new Date() },
  });
  const methods = await prisma.paymentMethod.findMany({ where: { customerId: customer.id, removedAt: null }, orderBy: { createdAt: "asc" } });

  // Keep a valid default: first card becomes default when none is set or the old one is gone.
  const current = methods.find((m) => m.id === customer.defaultPaymentMethodId);
  if (!current && methods[0]) {
    await prisma.paymentCustomer.update({ where: { id: customer.id }, data: { defaultPaymentMethodId: methods[0].id } });
    await provider().setDefaultCard(customer.providerCustomerId, methods[0].providerMethodId).catch(() => undefined);
  } else if (methods.length === 0 && customer.defaultPaymentMethodId) {
    await prisma.paymentCustomer.update({ where: { id: customer.id }, data: { defaultPaymentMethodId: null, autoPay: false } });
  }
  return methods;
}

export async function setDefaultMethod(customer: PaymentCustomer, methodId: string): Promise<void> {
  const method = await prisma.paymentMethod.findFirst({ where: { id: methodId, customerId: customer.id, removedAt: null } });
  if (!method) throw notFound("Payment method");
  await provider().setDefaultCard(customer.providerCustomerId, method.providerMethodId);
  await prisma.paymentCustomer.update({ where: { id: customer.id }, data: { defaultPaymentMethodId: method.id } });
}

export async function removeMethod(customer: PaymentCustomer, methodId: string): Promise<void> {
  const method = await prisma.paymentMethod.findFirst({ where: { id: methodId, customerId: customer.id, removedAt: null } });
  if (!method) throw notFound("Payment method");
  await provider().detachCard(method.providerMethodId);
  await prisma.paymentMethod.update({ where: { id: method.id }, data: { removedAt: new Date() } });
  await refreshPaymentMethods(await prisma.paymentCustomer.findUniqueOrThrow({ where: { id: customer.id } }));
}

export async function setAutoPay(customer: PaymentCustomer, enabled: boolean, adminId: string): Promise<PaymentCustomer> {
  if (enabled) {
    const methods = await refreshPaymentMethods(customer);
    if (methods.length === 0) {
      throw new AppError("VALIDATION", "Add a payment method before enabling automatic payments", {
        reason: "Automatic payments charge a saved card; there is none yet.",
        fix: "Use 'Add card' first.",
      });
    }
  }
  const updated = await prisma.paymentCustomer.update({ where: { id: customer.id }, data: { autoPay: enabled } });
  await audit({ adminId, action: enabled ? "ENABLED_AUTOMATIC_PAYMENTS" : "DISABLED_AUTOMATIC_PAYMENTS", resourceType: "payment_customer", resourceId: customer.id });
  return updated;
}

// ---- payments ----

export interface CreatePaymentInput {
  customer: PaymentCustomer;
  kind: "CAMPAIGN_FEE" | "PLAN" | "MANUAL";
  description: string;
  quote: Quote;
  idempotencyKey: string;
  campaignId?: string | null;
  scheduleId?: string | null;
  dueAt?: Date | null;
}

/** Create (or return the existing) payment for an idempotency key. */
export async function createPayment(input: CreatePaymentInput): Promise<Payment> {
  const existing = await prisma.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return existing;
  try {
    return await prisma.payment.create({
      data: {
        customerId: input.customer.id,
        kind: input.kind,
        description: input.description,
        amountCents: input.quote.totalCents,
        currency: input.quote.currency,
        status: "PENDING",
        idempotencyKey: input.idempotencyKey,
        campaignId: input.campaignId ?? null,
        scheduleId: input.scheduleId ?? null,
        dueAt: input.dueAt ?? new Date(),
      },
    });
  } catch (err) {
    // Race with a concurrent create using the same idempotency key — the
    // findUnique above already covers the common case; this closes the gap
    // between it and the create (same pattern as the invoice-number retry below).
    if (isUniqueConstraintError(err)) {
      const winner = await prisma.payment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (winner) return winner;
    }
    throw err;
  }
}

/**
 * Campaign fee: the quote is recomputed server-side from the current pricing
 * every time. The idempotency key includes the quoted amount specifically so
 * a pricing change never silently keeps an old, stale amount attached to a
 * still-unpaid payment while the campaign displays the new one — it mints a
 * fresh payment instead, and any other unpaid one for this campaign at the
 * old amount is canceled so the admin never sees two live quotes for one ad.
 */
export async function createCampaignFeePayment(customer: PaymentCustomer, campaignId: string): Promise<{ payment: Payment | null; quote: Quote }> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw notFound("Campaign");
  const quote = computeCampaignQuote(campaign, await getPricing());
  if (quote.free) {
    await prisma.campaign.update({ where: { id: campaignId }, data: { platformFeeCents: 0 } });
    return { payment: null, quote };
  }

  const stale = await prisma.payment.findMany({
    where: { campaignId, kind: "CAMPAIGN_FEE", status: { in: ["PENDING", "FAILED"] } },
  });
  const staleAtOldPrice = stale.filter((p) => p.amountCents !== quote.totalCents || p.currency !== quote.currency);
  if (staleAtOldPrice.length > 0) {
    await prisma.payment.updateMany({
      where: { id: { in: staleAtOldPrice.map((p) => p.id) } },
      data: { status: "CANCELED", canceledAt: new Date() },
    });
  }

  const payment = await createPayment({
    customer,
    kind: "CAMPAIGN_FEE",
    description: `Platform service fee — campaign "${campaign.name}"`,
    quote,
    idempotencyKey: `campaign-fee:${campaign.id}:${quote.totalCents}${quote.currency}`,
    campaignId: campaign.id,
  });
  await prisma.campaign.update({ where: { id: campaignId }, data: { platformFeeCents: quote.totalCents } });
  return { payment, quote };
}

/** Is a platform payment still owed before this campaign may be created in Meta? */
export async function campaignFeeStatus(campaignId: string): Promise<{ required: boolean; paid: boolean; payment: Payment | null; quote: Quote }> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw notFound("Campaign");
  const quote = computeCampaignQuote(campaign, await getPricing());
  if (quote.free) return { required: false, paid: true, payment: null, quote };
  const payment = await prisma.payment.findFirst({ where: { campaignId, kind: "CAMPAIGN_FEE" }, orderBy: { createdAt: "desc" } });
  return { required: true, paid: payment?.status === "SUCCEEDED", payment, quote };
}

export function assertCampaignFeePaid(status: Awaited<ReturnType<typeof campaignFeeStatus>>): void {
  if (status.required && !status.paid) {
    throw new AppError("REQUIRES_PAYMENT", "The platform service fee for this campaign has not been paid", {
      reason: `This platform charges ${(status.quote.totalCents / 100).toFixed(2)} ${status.quote.currency} per campaign. Meta's advertising spend is separate and billed by Meta.`,
      fix: "Open Billing and pay the fee, then create the campaign in Meta.",
      details: { paymentId: status.payment?.id ?? null, totalCents: status.quote.totalCents, currency: status.quote.currency },
    });
  }
}

export interface PayOutcome {
  payment: Payment;
  /** hosted Checkout URL when the customer must act; null when charged off-session */
  checkoutUrl: string | null;
}

/**
 * Collect a PENDING/FAILED payment. With automatic payments ON and a saved
 * card, charge off-session; otherwise open hosted Checkout. Never double-charges:
 * the provider idempotency key is derived from the payment's own key + attempt.
 *
 * A row that is already PROCESSING is an attempt whose outcome was never seen,
 * not a new one — it is settled against the provider rather than charged again.
 */
export async function collectPayment(payment: Payment, customer: PaymentCustomer, opts: { allowOffSession: boolean; returnPath?: string }): Promise<PayOutcome> {
  if (payment.status === "SUCCEEDED") return { payment, checkoutUrl: null };
  if (payment.status === "CANCELED" || payment.status === "REFUNDED") {
    throw new AppError("VALIDATION", `This payment is ${payment.status.toLowerCase()} and cannot be collected`);
  }
  const base = coreEnv().APP_URL;
  const metadata = { paymentId: payment.id, customerId: customer.id, kind: payment.kind, ...(payment.campaignId ? { campaignId: payment.campaignId } : {}) };

  const defaultMethod = customer.defaultPaymentMethodId
    ? await prisma.paymentMethod.findFirst({ where: { id: customer.defaultPaymentMethodId, removedAt: null } })
    : null;

  const offSessionMethod = opts.allowOffSession && customer.autoPay ? defaultMethod : null;

  // An attempt is in flight (or its answer was lost): the money may already be
  // gone, so starting a second payment for the same row is the one thing that
  // must never happen. Only a charge the provider never acknowledged may be
  // re-sent (as a replay under its own key); anything it did acknowledge is read.
  const inFlight = payment.status === "PROCESSING";
  if (inFlight && inFlightPaymentAction(payment, offSessionMethod !== null) === "read") {
    return { payment: await syncPaymentFromProvider(payment), checkoutUrl: null };
  }

  if (offSessionMethod) {
    let attempt = payment.attempts;
    if (!inFlight) {
      // Compare-and-swap on the row's CURRENT status: only one of two concurrent
      // triggers on the same payment (e.g. a manual retry vs. the hourly auto-retry
      // job) can win this update, so they can never mint two distinct, non-deduped
      // Stripe idempotency keys for what should be a single charge attempt.
      const claim = await prisma.payment.updateMany({
        where: { id: payment.id, status: payment.status },
        data: { status: "PROCESSING", attempts: { increment: 1 } },
      });
      const current = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      if (claim.count === 0) {
        // Someone else already claimed this attempt — hand back the current state
        // rather than racing them to also charge it.
        return { payment: current, checkoutUrl: null };
      }
      attempt = current.attempts;
    }
    // Re-sending the SAME attempt (same key, same parameters) makes Stripe replay
    // its original answer, so an unknown outcome resolves into the real one and
    // the attempt counter never advances past a charge we have not accounted for.
    const summary = await provider().chargeOffSession({
      customerId: customer.providerCustomerId,
      paymentMethodId: offSessionMethod.providerMethodId,
      amountCents: payment.amountCents,
      currency: payment.currency,
      description: payment.description,
      metadata,
      idempotencyKey: chargeIdempotencyKey(payment.idempotencyKey, attempt),
    });
    const updated = await applyIntent(payment.id, summary, { source: inFlight ? "off_session_replay" : "off_session" });
    return { payment: updated, checkoutUrl: null };
  }

  const attempt = payment.attempts + 1;
  const session = await provider().createPaymentSession({
    customerId: customer.providerCustomerId,
    amountCents: payment.amountCents,
    currency: payment.currency,
    description: payment.description,
    successUrl: `${base}/api/billing/return?session_id={CHECKOUT_SESSION_ID}&next=${encodeURIComponent(opts.returnPath ?? "/billing")}`,
    cancelUrl: `${base}${opts.returnPath ?? "/billing"}?canceled=1`,
    metadata,
    idempotencyKey: chargeIdempotencyKey(payment.idempotencyKey, attempt),
  });
  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { providerCheckoutSessionId: session.id, providerPaymentIntentId: session.paymentIntentId ?? undefined, attempts: attempt, status: "PENDING" },
  });
  return { payment: updated, checkoutUrl: session.url };
}

/** Apply a PaymentIntent snapshot to our Payment row and run the side effects of a status change. */
export async function applyIntent(paymentId: string, summary: StripeIntentSummary, ctx: { source: string }): Promise<Payment> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { customer: true } });
  if (!payment) throw notFound("Payment");
  const status = paymentStatusFromIntent(summary.status);
  if (payment.status === "SUCCEEDED" && status !== "SUCCEEDED") return payment; // never regress a settled payment

  const now = new Date();
  const data: Prisma.PaymentUpdateInput = {
    status,
    ...(summary.id ? { providerPaymentIntentId: summary.id } : {}),
    providerChargeId: summary.chargeId ?? payment.providerChargeId,
    receiptUrl: summary.receiptUrl ?? payment.receiptUrl,
  };
  if (status === "SUCCEEDED") Object.assign(data, { paidAt: payment.paidAt ?? now, failureCode: null, failureMessage: null, nextRetryAt: null });
  if (status === "FAILED") {
    const retry = payment.customer.autoPay ? nextRetryAt(payment.attempts, now) : null;
    Object.assign(data, { failedAt: now, failureCode: summary.failureCode, failureMessage: summary.failureMessage, nextRetryAt: retry });
  }
  if (status === "CANCELED") Object.assign(data, { canceledAt: now });

  const updated = await prisma.payment.update({ where: { id: paymentId }, data });
  if (status === "SUCCEEDED" && payment.status !== "SUCCEEDED") await onPaymentSucceeded(updated, ctx.source);
  if (status === "FAILED" && payment.status !== "FAILED") await onPaymentFailed(updated, ctx.source);
  return updated;
}

async function onPaymentSucceeded(payment: Payment, source: string): Promise<void> {
  // invoice (sequential per year; unique constraint guards the race)
  const year = new Date().getUTCFullYear();
  for (let i = 0; i < 3; i++) {
    const count = await prisma.invoice.count({ where: { number: { startsWith: `INV-${year}-` } } });
    try {
      await prisma.invoice.create({
        data: {
          paymentId: payment.id,
          number: invoiceNumber(year, count + 1 + i),
          amountCents: payment.amountCents,
          currency: payment.currency,
          lines: [{ description: payment.description, amountCents: payment.amountCents }] as unknown as Prisma.InputJsonValue,
          receiptUrl: payment.receiptUrl,
        },
      });
      break;
    } catch (err) {
      if (isUniqueConstraintError(err)) continue;
      log.warn("invoice not created", { paymentId: payment.id, ...errorFields(err) });
      break;
    }
  }
  if (payment.scheduleId) {
    const schedule = await prisma.billingSchedule.findUnique({ where: { id: payment.scheduleId } });
    if (schedule) {
      await prisma.billingSchedule.update({
        where: { id: schedule.id },
        data: { lastBilledAt: new Date(), nextBillingAt: nextBillingDate(schedule.nextBillingAt, schedule.intervalDays) },
      });
    }
  }
  await audit({ action: "PAYMENT_SUCCEEDED", resourceType: "payment", resourceId: payment.id, after: { amountCents: payment.amountCents, currency: payment.currency, kind: payment.kind, source } });
  await queueAdminAlert(
    `Payment received: ${(payment.amountCents / 100).toFixed(2)} ${payment.currency}`,
    `${payment.description}\nStatus: SUCCEEDED (${source})${payment.receiptUrl ? `\nReceipt: ${payment.receiptUrl}` : ""}`,
  ).catch(() => undefined);
}

async function onPaymentFailed(payment: Payment, source: string): Promise<void> {
  await audit({
    action: "PAYMENT_FAILED",
    resourceType: "payment",
    resourceId: payment.id,
    success: false,
    error: payment.failureMessage ?? payment.failureCode ?? "payment failed",
    after: { amountCents: payment.amountCents, currency: payment.currency, kind: payment.kind, source, nextRetryAt: payment.nextRetryAt?.toISOString() ?? null },
  });
  await queueAdminAlert(
    `Payment FAILED: ${(payment.amountCents / 100).toFixed(2)} ${payment.currency}`,
    `${payment.description}\nReason: ${payment.failureMessage ?? payment.failureCode ?? "unknown"}\n${payment.nextRetryAt ? `Automatic retry: ${payment.nextRetryAt.toISOString()}` : "No automatic retry — manual payment required."}`,
  ).catch(() => undefined);
}

/** Pull the current state from the provider (used when a webhook may have been missed). */
export async function syncPaymentFromProvider(payment: Payment): Promise<Payment> {
  if (payment.providerPaymentIntentId) {
    const summary = await provider().retrieveIntent(payment.providerPaymentIntentId);
    return applyIntent(payment.id, summary, { source: "sync" });
  }
  if (payment.providerCheckoutSessionId) {
    const session = await provider().retrieveCheckoutSession(payment.providerCheckoutSessionId);
    if (session.paymentIntentId) {
      await prisma.payment.update({ where: { id: payment.id }, data: { providerPaymentIntentId: session.paymentIntentId } });
      const summary = await provider().retrieveIntent(session.paymentIntentId);
      return applyIntent(payment.id, summary, { source: "sync" });
    }
  }
  return payment;
}

export async function cancelPayment(payment: Payment, adminId: string): Promise<Payment> {
  if (payment.status !== "PENDING" && payment.status !== "FAILED") {
    throw new AppError("VALIDATION", `A ${payment.status.toLowerCase()} payment cannot be cancelled`);
  }
  const updated = await prisma.payment.update({ where: { id: payment.id }, data: { status: "CANCELED", canceledAt: new Date(), nextRetryAt: null } });
  if (payment.scheduleId) await skipScheduleOccurrence(payment.scheduleId, payment.dueAt);
  await audit({ adminId, action: "PAYMENT_CANCELED", resourceType: "payment", resourceId: payment.id });
  return updated;
}

/**
 * Cancelling ONE occurrence must not end the series. The schedule's payment for
 * a period is minted under a key derived from nextBillingAt, so while that date
 * still points at the cancelled occurrence every later run just finds the same
 * dead row and does nothing — the recurring charge would stop for good. Stepping
 * the date on hands the next period back to the scheduler.
 */
async function skipScheduleOccurrence(scheduleId: string, dueAt: Date | null): Promise<void> {
  const schedule = await prisma.billingSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule || schedule.status !== "ACTIVE") return;
  // only ever step over the occurrence the schedule is actually standing on
  if (dueAt && schedule.nextBillingAt.getTime() !== dueAt.getTime()) return;
  await prisma.billingSchedule.update({
    where: { id: schedule.id },
    data: { nextBillingAt: nextBillingDate(schedule.nextBillingAt, schedule.intervalDays) },
  });
}

// ---- webhook events ----

export interface ProviderEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/** Idempotent: a redelivered event id is acknowledged and skipped. */
export async function recordAndProcessEvent(event: ProviderEvent): Promise<"processed" | "ignored" | "duplicate" | "failed"> {
  try {
    await prisma.billingEvent.create({
      data: { provider: "stripe", providerEventId: event.id, type: event.type, payload: event as unknown as Prisma.InputJsonValue, status: "RECEIVED" },
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) return "duplicate";
    throw err;
  }
  try {
    const handled = await handleProviderEvent(event);
    await prisma.billingEvent.update({
      where: { providerEventId: event.id },
      data: { status: handled ? "PROCESSED" : "IGNORED", processedAt: new Date() },
    });
    return handled ? "processed" : "ignored";
  } catch (err) {
    log.error("billing event failed", { eventId: event.id, type: event.type, ...errorFields(err) });
    await prisma.billingEvent.update({
      where: { providerEventId: event.id },
      // processedAt doubles as "when the handler last ran" so replayFailedBillingEvents
      // can space its attempts out instead of hammering a provider that is down.
      data: { status: "FAILED", error: eventError(err), processedAt: new Date() },
    });
    return "failed";
  }
}

function eventError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

/** How long a FAILED event waits before it is retried, and how long it is retried for. */
const EVENT_REPLAY_AFTER_MS = 5 * 60_000;
const EVENT_REPLAY_WINDOW_MS = 24 * 3600_000;

/**
 * Replay events whose handler threw. Stripe is ACKed even then — retrying into
 * our own bug only burns its retry budget and eventually disables the endpoint —
 * so without this pass a failed event is simply lost, and with it whatever it
 * carried (a settled PaymentIntent that never reaches its Payment row).
 *
 * Replaying is safe because every handler is idempotent: it re-reads the object
 * from Stripe and applyIntent never regresses a payment that already settled.
 * After EVENT_REPLAY_WINDOW_MS the row is left FAILED for an admin to look at
 * rather than retried forever.
 */
export async function replayFailedBillingEvents(now: Date = new Date()): Promise<{ replayed: number; recovered: number; failed: number }> {
  const result = { replayed: 0, recovered: 0, failed: 0 };
  if (!paymentsConfigured()) return result;
  const due = await prisma.billingEvent.findMany({
    where: {
      status: "FAILED",
      receivedAt: { gte: new Date(now.getTime() - EVENT_REPLAY_WINDOW_MS) },
      OR: [{ processedAt: null }, { processedAt: { lt: new Date(now.getTime() - EVENT_REPLAY_AFTER_MS) } }],
    },
    orderBy: { receivedAt: "asc" },
    take: 25,
  });
  for (const row of due) {
    const event = row.payload as unknown as ProviderEvent;
    if (!event?.id || !event.type || !event.data?.object) {
      log.warn("billing event not replayable — stored payload is not an event", { eventId: row.providerEventId });
      continue;
    }
    result.replayed++;
    try {
      const handled = await handleProviderEvent(event);
      await prisma.billingEvent.update({
        where: { id: row.id },
        data: { status: handled ? "PROCESSED" : "IGNORED", error: null, processedAt: new Date() },
      });
      result.recovered++;
    } catch (err) {
      result.failed++;
      log.warn("billing event replay failed", { eventId: row.providerEventId, type: row.type, ...errorFields(err) });
      await prisma.billingEvent.update({ where: { id: row.id }, data: { error: eventError(err), processedAt: new Date() } });
    }
  }
  if (result.replayed > 0) log.info("billing events replayed", result);
  return result;
}

async function handleProviderEvent(event: ProviderEvent): Promise<boolean> {
  const obj = event.data.object;
  const metadata = (obj.metadata ?? {}) as Record<string, string>;

  switch (event.type) {
    case "checkout.session.completed": {
      const mode = String(obj.mode ?? "");
      if (mode === "setup") {
        const customer = await customerByProviderId(String(obj.customer ?? ""));
        if (customer) await refreshPaymentMethods(customer);
        return true;
      }
      const paymentId = metadata.paymentId;
      const intentId = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
      if (!paymentId) return false;
      if (intentId) {
        await prisma.payment.updateMany({ where: { id: paymentId }, data: { providerPaymentIntentId: intentId, providerCheckoutSessionId: String(obj.id) } });
        const summary = await provider().retrieveIntent(intentId);
        await applyIntent(paymentId, summary, { source: "checkout" });
      }
      const customer = await customerByProviderId(String(obj.customer ?? ""));
      if (customer) await refreshPaymentMethods(customer).catch(() => undefined);
      return true;
    }
    case "payment_intent.succeeded":
    case "payment_intent.payment_failed":
    case "payment_intent.canceled":
    case "payment_intent.processing": {
      const payment = await paymentForIntent(obj, metadata);
      if (!payment) return false;
      const summary = await provider().retrieveIntent(String(obj.id));
      await applyIntent(payment.id, summary, { source: event.type });
      return true;
    }
    case "charge.refunded": {
      const intentId = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
      if (!intentId) return false;
      const payment = await prisma.payment.findUnique({ where: { providerPaymentIntentId: intentId } });
      if (!payment) return false;
      // This event fires for partial refunds too. Only a refund that covers the
      // whole charge makes the payment REFUNDED; a partial one leaves it settled
      // (the platform kept the rest), with the amounts recorded in the audit log.
      const refund = summarizeRefund(obj);
      await prisma.payment.update({
        where: { id: payment.id },
        data: { refundedAt: new Date(), ...(refund.full ? { status: "REFUNDED" } : {}) },
      });
      await audit({
        action: refund.full ? "PAYMENT_REFUNDED" : "PAYMENT_PARTIALLY_REFUNDED",
        resourceType: "payment",
        resourceId: payment.id,
        after: { full: refund.full, refundedCents: refund.refundedCents, chargeCents: refund.chargeCents, currency: payment.currency },
      });
      return true;
    }
    case "payment_method.attached":
    case "payment_method.detached":
    case "payment_method.updated":
    case "customer.updated": {
      const providerCustomerId = event.type === "customer.updated" ? String(obj.id ?? "") : String(obj.customer ?? "");
      const customer = await customerByProviderId(providerCustomerId);
      if (!customer) return false;
      await refreshPaymentMethods(customer);
      return true;
    }
    default:
      return false;
  }
}

async function customerByProviderId(providerCustomerId: string): Promise<PaymentCustomer | null> {
  if (!providerCustomerId) return null;
  return prisma.paymentCustomer.findUnique({ where: { providerCustomerId } });
}

async function paymentForIntent(obj: Record<string, unknown>, metadata: Record<string, string>): Promise<Payment | null> {
  const byIntent = await prisma.payment.findUnique({ where: { providerPaymentIntentId: String(obj.id) } });
  if (byIntent) return byIntent;
  if (metadata.paymentId) return prisma.payment.findUnique({ where: { id: metadata.paymentId } });
  return null;
}

// ---- automatic payments (scheduler) ----

/** Every ACTIVE schedule whose date has come: charge automatically, or create a PENDING payment and tell the customer. */
export async function runDueSchedules(now: Date = new Date()): Promise<{ charged: number; pendingCreated: number; skipped: number }> {
  const result = { charged: 0, pendingCreated: 0, skipped: 0 };
  if (!paymentsConfigured()) return result;
  const due = await prisma.billingSchedule.findMany({ where: { status: "ACTIVE", nextBillingAt: { lte: now } }, include: { customer: true }, take: 100 });
  for (const schedule of due) {
    try {
      const payment = await createPayment({
        customer: schedule.customer,
        kind: schedule.campaignId ? "CAMPAIGN_FEE" : "PLAN",
        description: schedule.name,
        quote: { currency: schedule.currency, lines: [{ description: schedule.name, amountCents: schedule.amountCents }], subtotalCents: schedule.amountCents, taxCents: 0, totalCents: schedule.amountCents, free: false },
        idempotencyKey: `schedule:${schedule.id}:${schedule.nextBillingAt.getTime()}`,
        scheduleId: schedule.id,
        campaignId: schedule.campaignId,
        dueAt: schedule.nextBillingAt,
      });
      if (payment.status !== "PENDING") {
        // This period already has a payment that will never move the schedule on
        // by itself (a cancelled or refunded one succeeds nothing), so step over
        // it here too — otherwise every later run re-finds the same dead row
        // under the same idempotency key and the series stops for good.
        if (payment.status === "CANCELED" || payment.status === "REFUNDED") {
          await prisma.billingSchedule.update({
            where: { id: schedule.id },
            data: { nextBillingAt: nextBillingDate(schedule.nextBillingAt, schedule.intervalDays, now) },
          });
        }
        result.skipped++;
        continue;
      }
      if (schedule.customer.autoPay && schedule.customer.defaultPaymentMethodId) {
        await collectPayment(payment, schedule.customer, { allowOffSession: true });
        result.charged++;
      } else {
        // manual mode: the payment waits; the customer is notified once
        result.pendingCreated++;
        await queueAdminAlert(
          `Payment due: ${(payment.amountCents / 100).toFixed(2)} ${payment.currency}`,
          `${payment.description}\nAutomatic payments are OFF — open Billing to pay manually.`,
        ).catch(() => undefined);
        // move the schedule forward so the same period is not re-created
        await prisma.billingSchedule.update({
          where: { id: schedule.id },
          data: { nextBillingAt: nextBillingDate(schedule.nextBillingAt, schedule.intervalDays, now) },
        });
      }
    } catch (err) {
      log.error("schedule run failed", { scheduleId: schedule.id, ...errorFields(err) });
      result.skipped++;
    }
  }
  return result;
}

/** An off-session charge sits in PROCESSING this long before its outcome counts as lost. */
const PROCESSING_STALE_MS = 10 * 60_000;

/**
 * Settle charges whose outcome was never seen. A lost HTTP response leaves the
 * row PROCESSING with the money's fate unknown — the customer is blocked and the
 * platform cannot tell whether it was paid. Re-sending that same attempt (same
 * idempotency key) makes Stripe replay its original answer, so the row lands on
 * what actually happened without any risk of charging twice.
 */
export async function reconcileStuckPayments(now: Date = new Date()): Promise<number> {
  if (!paymentsConfigured()) return 0;
  const stuck = await prisma.payment.findMany({
    where: { status: "PROCESSING", updatedAt: { lt: new Date(now.getTime() - PROCESSING_STALE_MS) } },
    include: { customer: true },
    take: 50,
  });
  let settled = 0;
  for (const payment of stuck) {
    try {
      // A reference means the response DID come back at least once; then a plain
      // read is enough and no charge request needs to be re-sent at all.
      if (payment.providerPaymentIntentId || payment.providerCheckoutSessionId) {
        const read = await syncPaymentFromProvider(payment);
        if (read.status !== "PROCESSING") settled++;
        continue;
      }
      // Nothing to read, so the only way to learn the outcome is to re-send that
      // same attempt — which is a replay only while Stripe still remembers the
      // key. updatedAt is when the row was claimed: a replay that reaches Stripe
      // always writes (an id, or a decline), so an untraced row this old means
      // every attempt failed in transport.
      if (!canReplayCharge(payment.updatedAt, now)) {
        log.error("payment stuck in PROCESSING past Stripe's idempotency window — settle it by hand from the Stripe dashboard", {
          paymentId: payment.id,
          attempts: payment.attempts,
          chargeKey: chargeIdempotencyKey(payment.idempotencyKey, payment.attempts),
        });
        continue;
      }
      const updated = (await collectPayment(payment, payment.customer, { allowOffSession: true })).payment;
      if (updated.status !== "PROCESSING") settled++;
      else {
        // No way to re-send it either (the card or autoPay is gone): nobody here
        // can find out what happened, so say so instead of letting the row sit
        // in a silent counter forever.
        log.warn("payment stuck in PROCESSING with nothing to ask the provider about", { paymentId: payment.id, attempts: payment.attempts });
      }
    } catch (err) {
      log.error("payment reconcile failed", { paymentId: payment.id, ...errorFields(err) });
    }
  }
  return settled;
}

/** Retry FAILED automatic payments whose retry time has come (1d → 3d → 7d, then stop), after settling any charge left in the dark. */
export async function retryFailedPayments(now: Date = new Date()): Promise<{ retried: number; succeeded: number; reconciled: number }> {
  const result = { retried: 0, succeeded: 0, reconciled: 0 };
  if (!paymentsConfigured()) return result;
  result.reconciled = await reconcileStuckPayments(now);
  const due = await prisma.payment.findMany({
    where: { status: "FAILED", nextRetryAt: { lte: now }, customer: { autoPay: true, defaultPaymentMethodId: { not: null } } },
    include: { customer: true },
    take: 50,
  });
  for (const payment of due) {
    try {
      const outcome = await collectPayment(payment, payment.customer, { allowOffSession: true });
      result.retried++;
      if (outcome.payment.status === "SUCCEEDED") result.succeeded++;
    } catch (err) {
      log.error("payment retry failed", { paymentId: payment.id, ...errorFields(err) });
    }
  }
  return result;
}

/** Ensure the platform plan schedule exists for a customer when a plan is priced. */
export async function ensurePlanSchedule(customer: PaymentCustomer): Promise<void> {
  const pricing = await getPricing();
  const quote = computePlanQuote(pricing);
  const existing = await prisma.billingSchedule.findFirst({ where: { customerId: customer.id, campaignId: null, status: { not: "CANCELED" } } });
  if (quote.free) {
    if (existing) await prisma.billingSchedule.update({ where: { id: existing.id }, data: { status: "CANCELED", canceledAt: new Date() } });
    return;
  }
  if (existing) {
    await prisma.billingSchedule.update({ where: { id: existing.id }, data: { amountCents: quote.totalCents, currency: quote.currency, name: pricing.planName ?? "Platform plan", intervalDays: pricing.planIntervalDays } });
    return;
  }
  await prisma.billingSchedule.create({
    data: {
      customerId: customer.id,
      name: pricing.planName ?? "Platform plan",
      amountCents: quote.totalCents,
      currency: quote.currency,
      intervalDays: pricing.planIntervalDays,
      nextBillingAt: new Date(),
    },
  });
}
