import { afterEach, describe, expect, it } from "vitest";
import { formEncode, verifyStripeSignature, summarizeIntent, summarizeRefund, cardFromPaymentMethod } from "@/lib/billing/stripe";
import {
  campaignFeeCurrencyProblem,
  campaignQuoteOrProblem,
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
} from "@/lib/billing/pricing";
import { paymentConfig, paymentsConfigured, requirePaymentConfig } from "@/lib/billing/config";
import { hmacSha256 } from "@/lib/crypto";

/**
 * Money math and provider protocol details are pure and pinned here:
 * what the platform charges (never Meta's spend), how Stripe's webhook
 * signature is checked, how billing dates advance, and how retries stop.
 */

describe("computeCampaignQuote", () => {
  it("is free when nothing is priced — no fabricated fee", () => {
    const q = computeCampaignQuote({ dailyBudgetCents: 500 }, DEFAULT_PRICING);
    expect(q.free).toBe(true);
    expect(q.totalCents).toBe(0);
    expect(q.lines).toEqual([]);
  });
  it("adds a flat fee plus a percentage of the first budget period, then tax", () => {
    const pricing = { ...DEFAULT_PRICING, campaignFeeCents: 1000, campaignFeePercent: 10, taxPercent: 12 };
    // daily 5.00 → 7-day base 35.00 → 10% = 3.50; subtotal 13.50; tax 1.62; total 15.12
    const q = computeCampaignQuote({ dailyBudgetCents: 500 }, pricing);
    expect(q.lines.map((l) => l.amountCents)).toEqual([1000, 350]);
    expect(q.subtotalCents).toBe(1350);
    expect(q.taxCents).toBe(162);
    expect(q.totalCents).toBe(1512);
    expect(q.free).toBe(false);
  });
  it("uses the lifetime budget as the percentage base when present", () => {
    const pricing = { ...DEFAULT_PRICING, campaignFeePercent: 5 };
    expect(computeCampaignQuote({ lifetimeBudgetCents: 20000, dailyBudgetCents: 999 }, pricing).totalCents).toBe(1000);
  });
  it("prices the plan separately", () => {
    expect(computePlanQuote(DEFAULT_PRICING).free).toBe(true);
    const q = computePlanQuote({ ...DEFAULT_PRICING, planName: "Pro", planAmountCents: 2900, taxPercent: 0 });
    expect(q.totalCents).toBe(2900);
    expect(q.lines[0]!.description).toBe("Pro");
  });
});

/**
 * A percentage fee is a percentage OF the ad budget but is charged in the
 * platform's own currency, so the two have to BE the same currency. There is no
 * exchange rate in this platform and inventing one would over- or undercharge
 * by whatever the real rate is that day — so the fee is refused, loudly.
 */
describe("campaign fee across currencies", () => {
  const pricing = { ...DEFAULT_PRICING, currency: "USD", campaignFeePercent: 10, campaignFeeCents: 1000 };

  it("refuses to price a percentage of a budget held in another currency", () => {
    expect(() => computeCampaignQuote({ dailyBudgetCents: 500, currency: "UZS" }, pricing)).toThrow(/cannot be calculated/);
    try {
      computeCampaignQuote({ lifetimeBudgetCents: 20000, currency: "UZS" }, pricing);
      expect.unreachable("should have refused the mixed-currency fee");
    } catch (err) {
      const e = err as { reason?: string; fix?: string; details?: { campaignCurrency?: string; pricingCurrency?: string } };
      expect(e.reason).toMatch(/UZS/);
      expect(e.reason).toMatch(/USD/);
      // never an invented rate, and never a silent 0
      expect(e.fix).toMatch(/flat campaign fee|Billing/);
      expect(e.details).toMatchObject({ campaignCurrency: "UZS", pricingCurrency: "USD" });
    }
  });

  it("prices normally when the two agree, whatever the case", () => {
    expect(computeCampaignQuote({ dailyBudgetCents: 500, currency: "usd" }, pricing).totalCents).toBe(1350);
    expect(campaignFeeCurrencyProblem("USD", pricing)).toBeNull();
    expect(campaignFeeCurrencyProblem(null, pricing)).toBeNull();
    expect(campaignFeeCurrencyProblem("EUR", pricing)).toMatch(/EUR/);
  });

  it("only refuses when a percentage would actually be charged", () => {
    // no percentage configured → the flat fee is already in the pricing currency
    expect(computeCampaignQuote({ dailyBudgetCents: 500, currency: "UZS" }, { ...pricing, campaignFeePercent: 0 }).totalCents).toBe(1000);
    // no budget to take a percentage of
    expect(computeCampaignQuote({ dailyBudgetCents: 0, currency: "UZS" }, pricing).totalCents).toBe(1000);
  });

  /**
   * A screen that prices many campaigns at once must not go down with the whole
   * page over one unpriceable row — and must not show the flat half of a fee the
   * server would refuse either. That is what the non-throwing form is for.
   */
  it("hands a screen the refusal instead of throwing it", () => {
    expect(campaignQuoteOrProblem({ dailyBudgetCents: 500, currency: "UZS" }, pricing)).toMatchObject({ quote: null });
    expect(campaignQuoteOrProblem({ dailyBudgetCents: 500, currency: "UZS" }, pricing).problem).toMatch(/UZS/);
    const priceable = campaignQuoteOrProblem({ dailyBudgetCents: 500, currency: "USD" }, pricing);
    expect(priceable.problem).toBeNull();
    expect(priceable.quote?.totalCents).toBe(1350);
  });
});

/**
 * An off-session charge whose answer never arrived may or may not have taken the
 * money. Re-sending THAT attempt under its own key is a replay Stripe answers
 * from its own record; anything else — a new key, a second Checkout, a re-send
 * after Stripe has forgotten the key — is a second charge.
 */
describe("a charge whose outcome was never seen", () => {
  const untraced = { providerPaymentIntentId: null, providerCheckoutSessionId: null };

  it("replays only an attempt the provider never acknowledged, and only off-session", () => {
    expect(inFlightPaymentAction(untraced, true)).toBe("replay");
    // no off-session card → re-sending is impossible; read instead of opening a
    // second Checkout for money that may already be gone
    expect(inFlightPaymentAction(untraced, false)).toBe("read");
  });

  it("reads anything the provider did hand back a reference for", () => {
    expect(inFlightPaymentAction({ ...untraced, providerPaymentIntentId: "pi_1" }, true)).toBe("read");
    // a Checkout-born row was charged under a Checkout key entirely: an
    // off-session "replay" of it would be a brand-new, un-deduplicated charge
    expect(inFlightPaymentAction({ ...untraced, providerCheckoutSessionId: "cs_1" }, true)).toBe("read");
  });

  it("stops replaying once Stripe has forgotten the key (24h), rather than charging twice", () => {
    const sent = new Date("2026-09-20T00:00:00Z");
    expect(canReplayCharge(sent, new Date("2026-09-20T00:11:00Z"))).toBe(true);
    expect(canReplayCharge(sent, new Date("2026-09-20T23:59:00Z"))).toBe(true);
    expect(canReplayCharge(sent, new Date("2026-09-21T00:01:00Z"))).toBe(false);
  });
});

describe("billing dates and retries", () => {
  it("advances by the interval and skips periods already in the past (no drift)", () => {
    const prev = new Date("2026-08-01T00:00:00Z");
    expect(nextBillingDate(prev, 30, new Date("2026-08-15T00:00:00Z")).toISOString()).toBe("2026-08-31T00:00:00.000Z");
    // scheduler was down for two months → next is the first future period
    expect(nextBillingDate(prev, 30, new Date("2026-10-15T00:00:00Z")).toISOString()).toBe("2026-10-30T00:00:00.000Z");
  });
  it("retries after 1, 3 and 7 days, then gives up", () => {
    const failed = new Date("2026-09-12T10:00:00Z");
    expect(nextRetryAt(1, failed)?.toISOString()).toBe("2026-09-13T10:00:00.000Z");
    expect(nextRetryAt(2, failed)?.toISOString()).toBe("2026-09-15T10:00:00.000Z");
    expect(nextRetryAt(3, failed)?.toISOString()).toBe("2026-09-19T10:00:00.000Z");
    expect(nextRetryAt(4, failed)).toBeNull();
  });
  it("maps Stripe intent statuses onto the local lifecycle", () => {
    expect(paymentStatusFromIntent("succeeded")).toBe("SUCCEEDED");
    expect(paymentStatusFromIntent("requires_payment_method")).toBe("FAILED");
    expect(paymentStatusFromIntent("requires_action")).toBe("REQUIRES_ACTION");
    expect(paymentStatusFromIntent("processing")).toBe("PROCESSING");
    expect(paymentStatusFromIntent("canceled")).toBe("CANCELED");
    expect(paymentStatusFromIntent("weird")).toBe("PENDING");
  });
  it("numbers invoices per year with a padded sequence", () => {
    expect(invoiceNumber(2026, 7)).toBe("INV-2026-00007");
  });
  /**
   * The key carries no clock and no randomness: retrying an attempt whose answer
   * was lost must reuse the same key so Stripe replays the original charge
   * instead of taking the money again.
   */
  it("derives one charge key per attempt, deterministically", () => {
    expect(chargeIdempotencyKey("schedule:s1:1757000000000", 2)).toBe("schedule:s1:1757000000000:2");
    expect(chargeIdempotencyKey("p", 2)).toBe(chargeIdempotencyKey("p", 2));
    expect(chargeIdempotencyKey("p", 2)).not.toBe(chargeIdempotencyKey("p", 3));
  });
});

describe("Stripe form encoding", () => {
  it("nests objects and arrays the way Stripe expects", () => {
    const qs = formEncode({
      mode: "payment",
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 1500, product_data: { name: "Fee" } } }],
      metadata: { paymentId: "p1" },
      off_session: true,
      skip: undefined,
    }).toString();
    expect(decodeURIComponent(qs)).toBe(
      "mode=payment&line_items[0][quantity]=1&line_items[0][price_data][currency]=usd&line_items[0][price_data][unit_amount]=1500&line_items[0][price_data][product_data][name]=Fee&metadata[paymentId]=p1&off_session=true",
    );
  });
});

describe("Stripe webhook signature", () => {
  const secret = "whsec_test_secret";
  const body = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded", data: { object: { id: "pi_1" } } });
  const t = 1_800_000_000; // seconds
  const sig = hmacSha256(secret, `${t}.${body}`);

  it("accepts a correctly signed, fresh payload", () => {
    const r = verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, t * 1000 + 10_000);
    expect(r.ok).toBe(true);
  });
  it("accepts when any one of several v1 signatures matches (key rotation)", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=deadbeef,v1=${sig}`, secret, 300, t * 1000).ok).toBe(true);
  });
  it("rejects a tampered body, a wrong secret, a stale timestamp and a missing header", () => {
    expect(verifyStripeSignature(body + " ", `t=${t},v1=${sig}`, secret, 300, t * 1000)).toEqual({ ok: false, reason: "signature mismatch" });
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_other", 300, t * 1000).ok).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, 300, (t + 3600) * 1000)).toEqual({ ok: false, reason: "timestamp outside tolerance" });
    expect(verifyStripeSignature(body, null, secret).ok).toBe(false);
    expect(verifyStripeSignature(body, `v1=${sig}`, secret).ok).toBe(false);
  });
});

describe("reading Stripe objects", () => {
  it("summarises a PaymentIntent with its receipt and failure details", () => {
    const s = summarizeIntent({
      id: "pi_1",
      status: "requires_payment_method",
      amount: 1512,
      currency: "usd",
      latest_charge: { id: "ch_1", receipt_url: "https://pay.stripe.com/receipts/x" },
      last_payment_error: { code: "card_declined", decline_code: "insufficient_funds", message: "Your card has insufficient funds." },
    });
    expect(s).toEqual({
      id: "pi_1",
      status: "requires_payment_method",
      chargeId: "ch_1",
      receiptUrl: "https://pay.stripe.com/receipts/x",
      failureCode: "insufficient_funds",
      failureMessage: "Your card has insufficient funds.",
      amount: 1512,
      currency: "USD",
    });
  });
  it("tells a partial refund from a full one by the amounts Stripe reports", () => {
    expect(summarizeRefund({ amount: 1512, amount_refunded: 1512, refunded: true })).toEqual({ chargeCents: 1512, refundedCents: 1512, full: true });
    expect(summarizeRefund({ amount: 1512, amount_refunded: 500, refunded: false })).toEqual({ chargeCents: 1512, refundedCents: 500, full: false });
    // Stripe's own `refunded` flag wins even when the amounts are missing…
    expect(summarizeRefund({ refunded: true }).full).toBe(true);
    // …and an unreadable payload stays partial rather than writing off the payment
    expect(summarizeRefund({}).full).toBe(false);
    expect(summarizeRefund({ amount: "1512", amount_refunded: "1512" }).full).toBe(true);
  });
  it("keeps only display metadata of a card — never the number", () => {
    const c = cardFromPaymentMethod({ id: "pm_1", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030, fingerprint: "x" } });
    expect(c).toEqual({ id: "pm_1", brand: "visa", last4: "4242", expMonth: 12, expYear: 2030 });
    expect(JSON.stringify(c)).not.toContain("fingerprint");
  });
});

/**
 * "Configured" must mean the whole payment path works, not just that a secret
 * key exists — a webhook secret missing would silently strand every
 * asynchronous outcome (card setup, off-session charge confirmation) as if
 * everything were fine.
 */
describe("payment configuration gating", () => {
  afterEach(() => {
    delete process.env.PAYMENT_SECRET_KEY;
    delete process.env.PAYMENT_WEBHOOK_SECRET;
    delete process.env.PAYMENT_PROVIDER;
  });

  it("is unconfigured with no secret key at all", () => {
    expect(paymentConfig()).toBeNull();
    expect(paymentsConfigured()).toBe(false);
    expect(() => requirePaymentConfig()).toThrow(/not configured/);
  });

  it("paymentConfig() itself still returns a null webhookSecret (the webhook route needs that distinction)", () => {
    process.env.PAYMENT_SECRET_KEY = "sk_test_123";
    expect(paymentConfig()).toMatchObject({ secretKey: "sk_test_123", webhookSecret: null });
  });

  it("a secret key alone, with no webhook secret, is NOT fully configured", () => {
    process.env.PAYMENT_SECRET_KEY = "sk_test_123";
    expect(paymentsConfigured()).toBe(false);
    try {
      requirePaymentConfig();
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { reason?: string }).reason).toMatch(/webhook/i);
    }
  });

  it("both keys present is fully configured", () => {
    process.env.PAYMENT_SECRET_KEY = "sk_test_123";
    process.env.PAYMENT_WEBHOOK_SECRET = "whsec_123";
    expect(paymentsConfigured()).toBe(true);
    expect(requirePaymentConfig()).toMatchObject({ secretKey: "sk_test_123", webhookSecret: "whsec_123" });
  });
});
