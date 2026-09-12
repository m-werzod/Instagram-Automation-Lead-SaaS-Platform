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

/**
 * Platform fee for one campaign: flat fee + % of the first budget period
 * (daily budget × 7 days, or the lifetime budget). Tax is applied on top.
 */
export function computeCampaignQuote(
  campaign: { dailyBudgetCents?: number | null; lifetimeBudgetCents?: number | null },
  pricing: Pricing,
): Quote {
  const lines: QuoteLine[] = [];
  if (pricing.campaignFeeCents > 0) lines.push({ description: "Campaign service fee", amountCents: pricing.campaignFeeCents });
  if (pricing.campaignFeePercent > 0) {
    const base = campaign.lifetimeBudgetCents ?? (campaign.dailyBudgetCents ? campaign.dailyBudgetCents * 7 : 0);
    const pct = roundCents((base * pricing.campaignFeePercent) / 100);
    if (pct > 0) lines.push({ description: `Management fee (${pricing.campaignFeePercent}% of ${campaign.lifetimeBudgetCents ? "lifetime budget" : "7-day budget"})`, amountCents: pct });
  }
  return finishQuote(lines, pricing);
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
