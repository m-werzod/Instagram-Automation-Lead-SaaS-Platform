import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { metaEnv } from "@/lib/env";
import { verifyWebhookSignature, parseWebhookPayload, dedupeKeyForEvent, type WebhookPayload } from "@/lib/meta/webhooks";
import { sha256Hex } from "@/lib/crypto";
import { enqueue } from "@/lib/queue";
import { createLogger, errorFields } from "@/lib/logger";

const log = createLogger("webhook.instagram");

/**
 * Meta webhook endpoint (spec §31).
 *  GET  — subscription verification handshake (hub.challenge echo).
 *  POST — signature-validated event intake: persist → dedupe → enqueue.
 * Never does heavy work inline; always answers Meta fast.
 */

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  let expected: string;
  try {
    expected = metaEnv().META_WEBHOOK_VERIFY_TOKEN;
  } catch {
    return new NextResponse("webhook not configured", { status: 503 });
  }

  if (mode === "subscribe" && token === expected && challenge) {
    log.info("webhook verification handshake OK");
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  log.warn("webhook verification failed", { mode, tokenMatch: token === expected });
  return new NextResponse("verification failed", { status: 403 });
}

export async function POST(req: NextRequest) {
  let appSecret: string;
  try {
    appSecret = metaEnv().META_APP_SECRET;
  } catch {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  if (!verifyWebhookSignature(rawBody, signature, appSecret)) {
    log.warn("webhook signature INVALID — rejected", { hasSignature: Boolean(signature) });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    // Dedupe key: prefer stable event identifiers (message mid / comment id);
    // fall back to a payload hash.
    const events = parseWebhookPayload(payload);
    const dedupeKey =
      events.length > 0 ? events.map(dedupeKeyForEvent).join("|").slice(0, 500) : `raw:${sha256Hex(rawBody)}`;

    const existing = await prisma.webhookEvent.findUnique({ where: { dedupeKey } });
    if (existing) {
      // Meta redelivered — acknowledge without reprocessing.
      return NextResponse.json({ received: true, duplicate: true });
    }

    const event = await prisma.webhookEvent.create({
      data: {
        object: payload.object ?? "unknown",
        dedupeKey,
        payload: payload as object,
        signatureValid: true,
        status: "QUEUED",
      },
    });
    await enqueue("webhook.process", { webhookEventId: event.id }, { maxAttempts: 5, priority: 10 });
  } catch (err) {
    // Unique-violation race between two deliveries → still ack.
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      return NextResponse.json({ received: true, duplicate: true });
    }
    log.error("webhook intake failed", errorFields(err));
    // Still return 200 so Meta doesn't disable the subscription; the raw
    // payload is lost only if the DB is down, which pages the admin anyway.
    return NextResponse.json({ received: true, stored: false });
  }

  return NextResponse.json({ received: true });
}
