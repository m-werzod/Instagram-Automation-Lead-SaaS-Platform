import { NextRequest, NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { instagramAppCredentials, metaEnv } from "@/lib/env";
import {
  matchWebhookSecret,
  parseWebhookPayload,
  dedupeKeyForDelivery,
  type WebhookPayload,
  type WebhookSecret,
} from "@/lib/meta/webhooks";
import { safeEqual } from "@/lib/crypto";
import { enqueue, drainNow } from "@/lib/queue";
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

  // The verify token is a shared secret (which is why /api/meta/config-status
  // only shows it to staff), and this endpoint is public: a byte-by-byte `===`
  // hands its prefix to anyone willing to time the responses.
  const tokenMatch = token !== null && safeEqual(token, expected);
  if (mode === "subscribe" && tokenMatch && challenge) {
    log.info("webhook verification handshake OK");
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  log.warn("webhook verification failed", { mode, tokenMatch });
  return new NextResponse("verification failed", { status: 403 });
}

/**
 * Both Meta apps can deliver here and each signs with its OWN secret: DMs,
 * comments and mentions come from the Instagram Login app, Page leadgen from
 * the Facebook app. Instagram is tried first because it carries the primary
 * flow. Whichever is configured, a signature is still mandatory.
 */
function webhookSecrets(): WebhookSecret[] {
  const secrets: WebhookSecret[] = [];
  try {
    secrets.push({ source: "instagram", secret: instagramAppCredentials().appSecret });
  } catch {
    /* Instagram Login not configured — the Facebook app may still be */
  }
  try {
    secrets.push({ source: "facebook", secret: metaEnv().META_APP_SECRET });
  } catch {
    /* Facebook app not configured */
  }
  return secrets;
}

export async function POST(req: NextRequest) {
  const secrets = webhookSecrets();
  if (secrets.length === 0) {
    return NextResponse.json({ error: "not configured" }, { status: 503 });
  }

  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256");

  const signedBy = matchWebhookSecret(rawBody, signature, secrets);
  if (!signedBy) {
    log.warn("webhook signature INVALID — rejected", {
      hasSignature: Boolean(signature),
      tried: secrets.map((s) => s.source),
    });
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }
  log.debug("webhook signature verified", { signedBy });

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WebhookPayload;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  try {
    // Dedupe key: built from stable event identifiers (message mid / comment
    // id), falling back to a payload hash.
    const events = parseWebhookPayload(payload);
    const dedupeKey = dedupeKeyForDelivery(events, rawBody);

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
    // Process the event (and any lead it produces) right away, post-response,
    // so DM/comment replies and lead notifications don't wait for the cron.
    after(() => drainNow());
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
