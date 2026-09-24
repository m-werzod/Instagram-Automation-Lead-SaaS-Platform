import { hmacSha256, safeEqual } from "@/lib/crypto";
import { AppError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";

const log = createLogger("billing.stripe");

/**
 * Stripe over plain REST (form-encoded), the same way this codebase talks to
 * Meta and the AI providers — one small client, no SDK. Card numbers never
 * pass through here: customers enter them on Stripe-hosted Checkout, and we
 * only ever see payment-method ids and display metadata.
 *
 * Verified against the Stripe API reference: /v1/customers, /v1/checkout/sessions,
 * /v1/payment_intents (off_session + confirm), /v1/payment_methods,
 * /v1/billing_portal/sessions, /v1/refunds, webhook signature scheme v1.
 */

export const STRIPE_API = "https://api.stripe.com/v1";
export const STRIPE_VERSION = "2024-06-20";

export class PaymentProviderError extends AppError {
  readonly providerCode?: string;
  readonly declineCode?: string;
  readonly providerType?: string;
  constructor(message: string, opts: { status?: number; code?: string; declineCode?: string; type?: string } = {}) {
    super("PAYMENT_PROVIDER_ERROR", message, {
      status: opts.status && opts.status >= 400 && opts.status < 600 ? opts.status : 502,
      reason: [opts.type, opts.code, opts.declineCode].filter(Boolean).join(" / ") || undefined,
      fix:
        opts.type === "card_error"
          ? "The card was declined — try another card or contact the bank."
          : opts.status === 401
            ? "Check PAYMENT_SECRET_KEY."
            : "Retry in a moment; if it persists check the Stripe dashboard logs.",
    });
    this.name = "PaymentProviderError";
    this.providerCode = opts.code;
    this.declineCode = opts.declineCode;
    this.providerType = opts.type;
  }
  get isCardDeclined(): boolean {
    return this.providerType === "card_error";
  }
}

/** Stripe's nested form encoding: {a:{b:1}, c:[x,y]} → a[b]=1&c[0]=x&c[1]=y */
export function formEncode(obj: Record<string, unknown>, prefix?: string, out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object") formEncode(item as Record<string, unknown>, `${key}[${i}]`, out);
        else out.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === "object") {
      formEncode(v as Record<string, unknown>, key, out);
    } else {
      out.append(key, typeof v === "boolean" ? (v ? "true" : "false") : String(v));
    }
  }
  return out;
}

/**
 * Webhook signature (Stripe-Signature: t=…,v1=…). signed_payload = "{t}.{rawBody}",
 * HMAC-SHA256 with the endpoint secret, constant-time compare, replay window.
 */
export function verifyStripeSignature(
  rawBody: string,
  header: string | null,
  secret: string,
  toleranceSec = 300,
  nowMs = Date.now(),
): { ok: true; timestamp: number } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };
  const parts = header.split(",").map((p) => p.trim());
  const t = Number(parts.find((p) => p.startsWith("t="))?.slice(2));
  const sigs = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!Number.isFinite(t) || t <= 0) return { ok: false, reason: "missing timestamp" };
  if (sigs.length === 0) return { ok: false, reason: "missing v1 signature" };
  const expected = hmacSha256(secret, `${t}.${rawBody}`);
  if (!sigs.some((s) => s.length === expected.length && safeEqual(s, expected))) return { ok: false, reason: "signature mismatch" };
  if (Math.abs(nowMs / 1000 - t) > toleranceSec) return { ok: false, reason: "timestamp outside tolerance" };
  return { ok: true, timestamp: t };
}

export interface StripeRequestOptions {
  idempotencyKey?: string;
  timeoutMs?: number;
}

export class StripeClient {
  constructor(private readonly secretKey: string) {}

  async request<T = Record<string, unknown>>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, unknown>,
    opts: StripeRequestOptions = {},
  ): Promise<T> {
    const url = new URL(`${STRIPE_API}${path}`);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      "Stripe-Version": STRIPE_VERSION,
    };
    let body: string | undefined;
    if (params && method === "GET") url.search = formEncode(params).toString();
    else if (params) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = formEncode(params).toString();
    }
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      log.error("stripe network error", { path, error: String(err) });
      throw new PaymentProviderError("Could not reach the payment provider", { status: 503 });
    }
    clearTimeout(timer);

    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new PaymentProviderError(`Payment provider returned a non-JSON response (HTTP ${res.status})`, { status: res.status });
    }
    if (!res.ok) {
      const err = (json.error ?? {}) as { message?: string; code?: string; decline_code?: string; type?: string };
      log.warn("stripe error", { path, status: res.status, code: err.code, type: err.type });
      throw new PaymentProviderError(err.message ?? `Payment provider error (HTTP ${res.status})`, {
        status: res.status,
        code: err.code,
        declineCode: err.decline_code,
        type: err.type,
      });
    }
    return json as T;
  }
}

// ---- typed helpers over the raw client ----

export interface StripeCard {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

export interface StripeIntentSummary {
  id: string;
  status: string; // requires_payment_method | requires_confirmation | requires_action | processing | succeeded | canceled
  chargeId: string | null;
  receiptUrl: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  amount: number;
  currency: string;
}

export function summarizeIntent(pi: Record<string, unknown>): StripeIntentSummary {
  const charge = (pi.latest_charge ?? null) as Record<string, unknown> | string | null;
  const lastError = (pi.last_payment_error ?? null) as { code?: string; decline_code?: string; message?: string } | null;
  return {
    id: String(pi.id),
    status: String(pi.status ?? "unknown"),
    chargeId: typeof charge === "string" ? charge : charge ? String(charge.id) : null,
    receiptUrl: charge && typeof charge === "object" && typeof charge.receipt_url === "string" ? charge.receipt_url : null,
    failureCode: lastError?.decline_code ?? lastError?.code ?? null,
    failureMessage: lastError?.message ?? null,
    amount: Number(pi.amount ?? 0),
    currency: String(pi.currency ?? "usd").toUpperCase(),
  };
}

export interface StripeRefundSummary {
  /** the charge's own total, as Stripe reports it */
  chargeCents: number;
  refundedCents: number;
  /** true ONLY when Stripe says the whole charge went back */
  full: boolean;
}

/**
 * A charge.refunded event fires for partial refunds too, and Stripe reports the
 * amounts rather than a "partial" flag — so the split has to be read from
 * `refunded` / `amount_refunded` / `amount`. Anything else (an older payload
 * that omits the amounts) is reported as partial: keeping a payment marked paid
 * when only part of it came back is the honest reading, and a later full refund
 * fires its own event.
 */
export function summarizeRefund(charge: Record<string, unknown>): StripeRefundSummary {
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const chargeCents = num(charge.amount);
  const refundedCents = num(charge.amount_refunded);
  return { chargeCents, refundedCents, full: charge.refunded === true || (chargeCents > 0 && refundedCents >= chargeCents) };
}

export function cardFromPaymentMethod(pm: Record<string, unknown>): StripeCard {
  const card = (pm.card ?? {}) as { brand?: string; last4?: string; exp_month?: number; exp_year?: number };
  return {
    id: String(pm.id),
    brand: card.brand ?? null,
    last4: card.last4 ?? null,
    expMonth: card.exp_month ?? null,
    expYear: card.exp_year ?? null,
  };
}

export class StripeProvider {
  readonly name = "stripe" as const;
  private readonly client: StripeClient;
  constructor(secretKey: string) {
    this.client = new StripeClient(secretKey);
  }

  async createCustomer(input: { email?: string | null; name?: string | null; adminId: string }): Promise<string> {
    const c = await this.client.request<{ id: string }>("POST", "/customers", {
      ...(input.email ? { email: input.email } : {}),
      ...(input.name ? { name: input.name } : {}),
      metadata: { adminId: input.adminId, platform: "instagram-automation" },
    });
    return c.id;
  }

  /** Hosted page where the customer saves a card. Nothing is charged. */
  async createSetupSession(input: { customerId: string; successUrl: string; cancelUrl: string; metadata: Record<string, string> }): Promise<{ id: string; url: string }> {
    const s = await this.client.request<{ id: string; url: string }>("POST", "/checkout/sessions", {
      mode: "setup",
      customer: input.customerId,
      payment_method_types: ["card"],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      metadata: input.metadata,
    });
    return { id: s.id, url: s.url };
  }

  /** Hosted page where the customer pays one amount; the card is saved for later off-session charges. */
  async createPaymentSession(input: {
    customerId: string;
    amountCents: number;
    currency: string;
    description: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<{ id: string; url: string; paymentIntentId: string | null }> {
    const s = await this.client.request<{ id: string; url: string; payment_intent?: string | null }>(
      "POST",
      "/checkout/sessions",
      {
        mode: "payment",
        customer: input.customerId,
        payment_method_types: ["card"],
        line_items: [
          {
            quantity: 1,
            price_data: { currency: input.currency.toLowerCase(), unit_amount: input.amountCents, product_data: { name: input.description } },
          },
        ],
        payment_intent_data: { setup_future_usage: "off_session", metadata: input.metadata },
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: input.metadata,
      },
      { idempotencyKey: `cs:${input.idempotencyKey}` },
    );
    return { id: s.id, url: s.url, paymentIntentId: s.payment_intent ?? null };
  }

  /** Charge a saved card with the customer absent (automatic payments). */
  async chargeOffSession(input: {
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    currency: string;
    description: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
  }): Promise<StripeIntentSummary> {
    try {
      const pi = await this.client.request<Record<string, unknown>>(
        "POST",
        "/payment_intents",
        {
          amount: input.amountCents,
          currency: input.currency.toLowerCase(),
          customer: input.customerId,
          payment_method: input.paymentMethodId,
          off_session: true,
          confirm: true,
          description: input.description,
          metadata: input.metadata,
          "expand[]": "latest_charge",
        },
        { idempotencyKey: `pi:${input.idempotencyKey}` },
      );
      return summarizeIntent(pi);
    } catch (err) {
      // A decline is a legitimate outcome, not a transport failure: Stripe still
      // creates the PaymentIntent; surface it as a failed summary.
      if (err instanceof PaymentProviderError && err.isCardDeclined) {
        return {
          id: "",
          status: "requires_payment_method",
          chargeId: null,
          receiptUrl: null,
          failureCode: err.declineCode ?? err.providerCode ?? "card_declined",
          failureMessage: err.message,
          amount: input.amountCents,
          currency: input.currency.toUpperCase(),
        };
      }
      throw err;
    }
  }

  async retrieveIntent(id: string): Promise<StripeIntentSummary> {
    const pi = await this.client.request<Record<string, unknown>>("GET", `/payment_intents/${encodeURIComponent(id)}`, { "expand[]": "latest_charge" });
    return summarizeIntent(pi);
  }

  async retrieveCheckoutSession(id: string): Promise<{ id: string; mode: string; status: string | null; paymentStatus: string | null; paymentIntentId: string | null; setupIntentId: string | null; customerId: string | null }> {
    const s = await this.client.request<Record<string, unknown>>("GET", `/checkout/sessions/${encodeURIComponent(id)}`);
    return {
      id: String(s.id),
      mode: String(s.mode ?? ""),
      status: (s.status as string | null) ?? null,
      paymentStatus: (s.payment_status as string | null) ?? null,
      paymentIntentId: typeof s.payment_intent === "string" ? s.payment_intent : null,
      setupIntentId: typeof s.setup_intent === "string" ? s.setup_intent : null,
      customerId: typeof s.customer === "string" ? s.customer : null,
    };
  }

  async listCards(customerId: string): Promise<StripeCard[]> {
    const res = await this.client.request<{ data?: Array<Record<string, unknown>> }>("GET", "/payment_methods", { customer: customerId, type: "card", limit: 20 });
    return (res.data ?? []).map(cardFromPaymentMethod);
  }

  async detachCard(paymentMethodId: string): Promise<void> {
    await this.client.request("POST", `/payment_methods/${encodeURIComponent(paymentMethodId)}/detach`);
  }

  async setDefaultCard(customerId: string, paymentMethodId: string): Promise<void> {
    await this.client.request("POST", `/customers/${encodeURIComponent(customerId)}`, { invoice_settings: { default_payment_method: paymentMethodId } });
  }

  /** Stripe's own self-service page (needs the portal to be enabled once in the Stripe dashboard). */
  async portalUrl(customerId: string, returnUrl: string): Promise<string | null> {
    try {
      const s = await this.client.request<{ url: string }>("POST", "/billing_portal/sessions", { customer: customerId, return_url: returnUrl });
      return s.url;
    } catch (err) {
      log.warn("billing portal unavailable", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  async refund(paymentIntentId: string, idempotencyKey: string): Promise<{ id: string; status: string }> {
    const r = await this.client.request<{ id: string; status: string }>("POST", "/refunds", { payment_intent: paymentIntentId }, { idempotencyKey: `re:${idempotencyKey}` });
    return { id: r.id, status: r.status };
  }
}
