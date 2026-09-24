import { AppError } from "@/lib/errors";

/**
 * Pricing math — pure, unit-tested, shared by the server (source of truth) and
 * the wizard (preview only; the server recomputes before anything is charged).
 * Meta advertising spend is NEVER part of these numbers: Meta bills the ad
 * account directly. These are the platform's own service fees.
 */

export interface Pricing {
  currency: string;
  campaignFeeCents: number;
  campaignFeePercent: number;
  planName: string | null;
  planAmountCents: number;
  planIntervalDays: number;
  taxPercent: number;
}

export const DEFAULT_PRICING: Pricing = {
  currency: "USD",
  campaignFeeCents: 0,
  campaignFeePercent: 0,
  planName: null,
  planAmountCents: 0,
  planIntervalDays: 30,
  taxPercent: 0,
};

/**
 * Every amount in this file is stored as "cents" (1/100th of a unit) and sent
 * to Stripe's `amount`/`unit_amount` as-is. That is only correct for a normal
 * 2-decimal currency — for one of Stripe's zero-decimal currencies (JPY, KRW,
 * VND, …) the same integer means whole units, a 100x overcharge. Deliberately
 * kept to currencies confirmed both 2-decimal AND commonly usable as a Stripe
 * presentment currency; add to this list only after checking both at
 * https://docs.stripe.com/currencies, never just because a customer asked.
 */
export const SUPPORTED_PRICING_CURRENCIES = ["USD", "EUR", "GBP"] as const;

export interface QuoteLine {
  description: string;
  amountCents: number;
}

export interface Quote {
  currency: string;
  lines: QuoteLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** nothing to charge → the campaign needs no platform payment */
  free: boolean;
}

function roundCents(n: number): number {
  return Math.round(n + Number.EPSILON);
}

/** What a campaign fee is computed from: its budget, and the currency that budget is held in. */
export interface CampaignQuoteInput {
  dailyBudgetCents?: number | null;
  lifetimeBudgetCents?: number | null;
  currency?: string | null;
}

/**
 * A percentage fee is a percentage OF the campaign's budget, and the result is
 * charged in the platform's pricing currency — so the two only mean the same
 * thing when they ARE the same currency. There is no exchange rate anywhere in
 * this platform, and making one up would over- or undercharge by whatever the
 * real rate happens to be that day, so a mismatch is refused outright.
 * Returns null when nothing is wrong (including when the campaign currency is
 * unknown to the caller, e.g. the wizard previewing a budget before an account
 * is chosen — the server recomputes with the real row before charging).
 */
export function campaignFeeCurrencyProblem(campaignCurrency: string | null | undefined, pricing: Pricing): string | null {
  if (!campaignCurrency) return null;
  if (campaignCurrency.toUpperCase() === pricing.currency.toUpperCase()) return null;
  return `This campaign's budget is in ${campaignCurrency.toUpperCase()} but the platform's percentage fee is charged in ${pricing.currency.toUpperCase()}.`;
}

/** The amount a percentage fee is taken from: the lifetime budget, or the first 7 days of a daily one. */
function percentFeeBase(campaign: CampaignQuoteInput): number {
  return campaign.lifetimeBudgetCents ?? (campaign.dailyBudgetCents ? campaign.dailyBudgetCents * 7 : 0);
}

/** Why no fee at all can be worked out for this campaign, or null. Only a percentage that would really be charged can reach this. */
function campaignQuoteProblem(campaign: CampaignQuoteInput, pricing: Pricing): string | null {
  if (pricing.campaignFeePercent <= 0 || percentFeeBase(campaign) <= 0) return null;
  const mismatch = campaignFeeCurrencyProblem(campaign.currency, pricing);
  return mismatch ? `${mismatch} This platform converts no currencies, so the percentage cannot be applied.` : null;
}

/**
 * Platform fee for one campaign: flat fee + % of the first budget period
 * (daily budget × 7 days, or the lifetime budget). Tax is applied on top.
 * Throws when a percentage fee would have to cross currencies (see above).
 */
export function computeCampaignQuote(campaign: CampaignQuoteInput, pricing: Pricing): Quote {
  const problem = campaignQuoteProblem(campaign, pricing);
  if (problem) {
    throw new AppError("VALIDATION", "The platform fee for this campaign cannot be calculated", {
      reason: problem,
      fix: `Set the pricing currency to ${campaignCurrencyHint(campaign.currency)} in Billing → Pricing, or use a flat campaign fee instead of a percentage.`,
      details: { campaignCurrency: campaign.currency, pricingCurrency: pricing.currency, campaignFeePercent: pricing.campaignFeePercent },
    });
  }
  const lines: QuoteLine[] = [];
  if (pricing.campaignFeeCents > 0) lines.push({ description: "Campaign service fee", amountCents: pricing.campaignFeeCents });
  const base = percentFeeBase(campaign);
  if (pricing.campaignFeePercent > 0 && base > 0) {
    const pct = roundCents((base * pricing.campaignFeePercent) / 100);
    if (pct > 0) lines.push({ description: `Management fee (${pricing.campaignFeePercent}% of ${campaign.lifetimeBudgetCents ? "lifetime budget" : "7-day budget"})`, amountCents: pct });
  }
  return finishQuote(lines, pricing);
}

/**
 * The same fee, asked for by a screen instead of by a charge. A list that shows
 * one fee per campaign must not go down with the whole page over a single
 * unpriceable row, and showing just the flat half of a refused fee would quote
 * a price the server will not honour — so the refusal is returned, not thrown.
 */
export function campaignQuoteOrProblem(
  campaign: CampaignQuoteInput,
  pricing: Pricing,
): { quote: Quote; problem: null } | { quote: null; problem: string } {
  const problem = campaignQuoteProblem(campaign, pricing);
  return problem ? { quote: null, problem } : { quote: computeCampaignQuote(campaign, pricing), problem: null };
}

/** Only suggest aligning onto a currency this platform can actually bill in. */
function campaignCurrencyHint(campaignCurrency: string | null | undefined): string {
  const code = campaignCurrency?.toUpperCase() ?? "";
  return (SUPPORTED_PRICING_CURRENCIES as readonly string[]).includes(code) ? code : `the ad account's currency (${SUPPORTED_PRICING_CURRENCIES.join(", ")} are billable here)`;
}

export function computePlanQuote(pricing: Pricing): Quote {
  const lines: QuoteLine[] = pricing.planAmountCents > 0 ? [{ description: pricing.planName ?? "Platform plan", amountCents: pricing.planAmountCents }] : [];
  return finishQuote(lines, pricing);
}

function finishQuote(lines: QuoteLine[], pricing: Pricing): Quote {
  const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
  const taxCents = pricing.taxPercent > 0 ? roundCents((subtotalCents * pricing.taxPercent) / 100) : 0;
  return { currency: pricing.currency, lines, subtotalCents, taxCents, totalCents: subtotalCents + taxCents, free: subtotalCents + taxCents <= 0 };
}

/** Next billing instant: strictly after `from`, stepping by the interval from the previous date (no drift on late runs). */
export function nextBillingDate(previous: Date, intervalDays: number, from: Date = new Date()): Date {
  const step = Math.max(1, intervalDays) * 86400_000;
  let next = previous.getTime() + step;
  while (next <= from.getTime()) next += step;
  return new Date(next);
}

/** Retry policy for failed automatic payments: 1 day, 3 days, 7 days — then stop. */
export const RETRY_DELAYS_DAYS = [1, 3, 7] as const;

/**
 * The provider idempotency key for ONE charge attempt. Derived only from the
 * payment's own key and the attempt number — never from the clock or a random
 * value — because that is what makes a retry of an attempt whose outcome was
 * never seen (the response was lost in flight) safe: the same key makes Stripe
 * replay its original answer instead of taking the money a second time.
 */
export function chargeIdempotencyKey(paymentKey: string, attempt: number): string {
  return `${paymentKey}:${attempt}`;
}

/**
 * What to do with a payment already PROCESSING: its outcome was never seen, so
 * the money may or may not be gone. Re-sending the charge is only a replay —
 * same key, Stripe's original answer, no second charge — while the provider
 * never handed back a reference for that attempt. Once it did, reading settles
 * the row for free; and a row that got its reference from hosted Checkout was
 * charged under a Checkout key entirely, so "re-sending" it as an off-session
 * charge would be a brand-new, un-deduplicated one.
 */
/**
 * Stripe only remembers an idempotency key for 24 hours (documented at
 * https://docs.stripe.com/api/idempotent_requests). Past that it has forgotten
 * the original request, so "re-sending the same attempt" is not a replay any
 * more — it is a second charge. A row that old is left for a human to settle
 * against the Stripe dashboard instead.
 */
export const IDEMPOTENCY_WINDOW_MS = 24 * 3600_000;

export function canReplayCharge(sentAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - sentAt.getTime() < IDEMPOTENCY_WINDOW_MS;
}

export function inFlightPaymentAction(
  payment: { providerPaymentIntentId: string | null; providerCheckoutSessionId: string | null },
  canChargeOffSession: boolean,
): "replay" | "read" {
  const untraced = !payment.providerPaymentIntentId && !payment.providerCheckoutSessionId;
  return untraced && canChargeOffSession ? "replay" : "read";
}

export function nextRetryAt(attempts: number, failedAt: Date = new Date()): Date | null {
  const delay = RETRY_DELAYS_DAYS[attempts - 1];
  if (delay === undefined) return null;
  return new Date(failedAt.getTime() + delay * 86400_000);
}

export type PaymentStatusValue = "PENDING" | "PROCESSING" | "REQUIRES_ACTION" | "SUCCEEDED" | "FAILED" | "CANCELED" | "REFUNDED";

/** Stripe PaymentIntent status → our status. */
export function paymentStatusFromIntent(intentStatus: string): PaymentStatusValue {
  switch (intentStatus) {
    case "succeeded":
      return "SUCCEEDED";
    case "processing":
      return "PROCESSING";
    case "requires_action":
    case "requires_confirmation":
      return "REQUIRES_ACTION";
    case "canceled":
      return "CANCELED";
    case "requires_payment_method":
      return "FAILED";
    default:
      return "PENDING";
  }
}

/** Invoice number: INV-<year>-<sequence zero-padded to 5>. */
export function invoiceNumber(year: number, sequence: number): string {
  return `INV-${year}-${String(sequence).padStart(5, "0")}`;
}
