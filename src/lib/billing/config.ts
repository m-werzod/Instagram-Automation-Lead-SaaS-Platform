import { AppError } from "@/lib/errors";

/**
 * Payment provider configuration. Everything is optional: without a secret key
 * the platform runs with billing switched off and the UI says so — it never
 * pretends a payment happened.
 */

export interface PaymentConfig {
  provider: "stripe";
  secretKey: string;
  webhookSecret: string | null;
  publishableKey: string | null;
}

export function paymentConfig(): PaymentConfig | null {
  const secretKey = process.env.PAYMENT_SECRET_KEY?.trim() || process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  const provider = (process.env.PAYMENT_PROVIDER?.trim().toLowerCase() || "stripe") as "stripe";
  if (provider !== "stripe") return null;
  return {
    provider,
    secretKey,
    webhookSecret: process.env.PAYMENT_WEBHOOK_SECRET?.trim() || process.env.STRIPE_WEBHOOK_SECRET?.trim() || null,
    publishableKey: process.env.PAYMENT_PUBLISHABLE_KEY?.trim() || process.env.STRIPE_PUBLISHABLE_KEY?.trim() || null,
  };
}

/**
 * "Configured" requires a webhook secret too, not just a secret key. Without
 * one, the webhook route (correctly) 503s every Stripe event — a Checkout
 * setup or an async payment outcome would never confirm, so the rest of the
 * app must not present itself as fully working when only half of it is wired.
 */
export function paymentsConfigured(): boolean {
  const cfg = paymentConfig();
  return Boolean(cfg && cfg.webhookSecret);
}

export function requirePaymentConfig(): PaymentConfig {
  const cfg = paymentConfig();
  if (!cfg) {
    throw new AppError("PAYMENT_NOT_CONFIGURED", "Payments are not configured on this installation", {
      reason: "PAYMENT_SECRET_KEY is not set, so no payment provider is connected.",
      fix: "Set PAYMENT_SECRET_KEY (Stripe secret key) and PAYMENT_WEBHOOK_SECRET in the environment, then restart.",
    });
  }
  if (!cfg.webhookSecret) {
    throw new AppError("PAYMENT_NOT_CONFIGURED", "Payments are not fully configured on this installation", {
      reason: "PAYMENT_SECRET_KEY is set but PAYMENT_WEBHOOK_SECRET is not, so Stripe's webhook is rejected — card setup and payment outcomes would never confirm.",
      fix: "Create the webhook endpoint in the Stripe Dashboard and set PAYMENT_WEBHOOK_SECRET, then restart.",
    });
  }
  return cfg;
}

/** Test-mode keys are visible in the UI so nobody mistakes a rehearsal for a real charge. */
export function paymentsInTestMode(): boolean {
  const cfg = paymentConfig();
  return Boolean(cfg && /^sk_test_/.test(cfg.secretKey));
}
