import { NextRequest, NextResponse, after } from "next/server";
import { paymentConfig } from "@/lib/billing/config";
import { verifyStripeSignature } from "@/lib/billing/stripe";
import { recordAndProcessEvent, replayFailedBillingEvents, type ProviderEvent } from "@/lib/billing/service";
import { createLogger, errorFields } from "@/lib/logger";

const log = createLogger("webhook.stripe");

/**
 * Stripe webhook: signature is mandatory, every event id is stored once
 * (redeliveries are acknowledged, never reprocessed), and the handler always
 * answers quickly. Configure the endpoint as {APP_URL}/api/webhooks/stripe with
 * events: checkout.session.completed, payment_intent.*, charge.refunded,
 * payment_method.*, customer.updated.
 */
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const cfg = paymentConfig();
  if (!cfg) return NextResponse.json({ error: "payments not configured" }, { status: 503 });
  if (!cfg.webhookSecret) {
    log.error("PAYMENT_WEBHOOK_SECRET is not set — refusing unsigned events");
    return NextResponse.json({ error: "webhook secret not configured" }, { status: 503 });
  }

  const rawBody = await req.text();
  const check = verifyStripeSignature(rawBody, req.headers.get("stripe-signature"), cfg.webhookSecret);
  if (!check.ok) {
    log.warn("stripe signature rejected", { reason: check.reason });
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  let event: ProviderEvent;
  try {
    event = JSON.parse(rawBody) as ProviderEvent;
    if (!event.id || !event.type || !event.data?.object) throw new Error("malformed event");
  } catch {
    return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  }

  const outcome = await recordAndProcessEvent(event);
  // A failed handler is our problem, not Stripe's — still 200 so Stripe does not
  // retry into the same bug (and eventually disable the endpoint). The ACK is
  // only honest because the stored event is replayed on our own side: after()
  // runs once the response is already out, so this costs Stripe nothing.
  after(async () => {
    try {
      await replayFailedBillingEvents();
    } catch (err) {
      log.error("billing event replay pass failed", errorFields(err));
    }
  });
  return NextResponse.json({ received: true, outcome });
}
