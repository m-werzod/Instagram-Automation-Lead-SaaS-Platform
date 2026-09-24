import { hmacSha256, safeEqual, sha256Hex } from "@/lib/crypto";

/**
 * Webhook signature validation + payload normalization
 * (docs/META_API.md §4). Parsing is pure/deterministic → unit tested.
 */

export function verifyWebhookSignature(rawBody: string | Buffer, signatureHeader: string | null, appSecret: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = hmacSha256(appSecret, rawBody);
  const provided = signatureHeader.slice("sha256=".length);
  return safeEqual(expected, provided);
}

export type WebhookSecretSource = "instagram" | "facebook";

export interface WebhookSecret {
  source: WebhookSecretSource;
  secret: string;
}

/**
 * Meta signs a delivery with the secret of the APP the subscription belongs to,
 * and Instagram Login is a separate app with a separate secret from the
 * Facebook app that carries advertising and Page leadgen. A delivery is genuine
 * when it matches EITHER configured secret; the order only decides which
 * constant-time compare runs first. Returns which app signed it, so the log
 * says where an unexpected delivery came from.
 */
export function matchWebhookSecret(
  rawBody: string | Buffer,
  signatureHeader: string | null,
  secrets: readonly WebhookSecret[],
): WebhookSecretSource | null {
  for (const { source, secret } of secrets) {
    if (verifyWebhookSignature(rawBody, signatureHeader, secret)) return source;
  }
  return null;
}

// ---- normalized event model ----

export type NormalizedEvent =
  | {
      type: "message";
      entryId: string; // IG professional account user id
      senderIgsid: string;
      recipientId: string;
      mid: string | null;
      text: string | null;
      attachments: unknown[] | null;
      quickReplyPayload: string | null;
      isEcho: boolean;
      timestamp: number;
    }
  | {
      type: "postback";
      entryId: string;
      senderIgsid: string;
      mid: string | null;
      payload: string;
      title: string | null;
      timestamp: number;
    }
  | {
      type: "comment";
      entryId: string;
      commentId: string;
      mediaId: string | null;
      text: string | null;
      fromId: string | null;
      fromUsername: string | null;
      timestamp: number;
    }
  | {
      type: "leadgen";
      entryId: string; // page id
      leadgenId: string;
      formId: string | null;
      timestamp: number;
    }
  | {
      type: "other";
      entryId: string;
      field: string | null;
      timestamp: number;
    };

interface WebhookMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    attachments?: unknown[];
    quick_reply?: { payload?: string };
  };
  postback?: { mid?: string; payload?: string; title?: string };
  read?: unknown;
  reaction?: unknown;
}

interface WebhookChange {
  field?: string;
  value?: {
    id?: string; // comment id
    media?: { id?: string };
    text?: string;
    from?: { id?: string; username?: string };
    leadgen_id?: string;
    form_id?: string;
    created_time?: number;
  };
}

export interface WebhookEntry {
  id?: string;
  time?: number;
  messaging?: WebhookMessaging[];
  changes?: WebhookChange[];
}

export interface WebhookPayload {
  object?: string;
  entry?: WebhookEntry[];
}

export function parseWebhookPayload(payload: WebhookPayload): NormalizedEvent[] {
  const events: NormalizedEvent[] = [];
  for (const entry of payload.entry ?? []) {
    const entryId = String(entry.id ?? "");
    const entryTime = entry.time ?? Date.now();

    for (const m of entry.messaging ?? []) {
      const ts = m.timestamp ?? entryTime;
      if (m.message) {
        events.push({
          type: "message",
          entryId,
          senderIgsid: String(m.sender?.id ?? ""),
          recipientId: String(m.recipient?.id ?? ""),
          mid: m.message.mid ?? null,
          text: m.message.text ?? null,
          attachments: m.message.attachments ?? null,
          quickReplyPayload: m.message.quick_reply?.payload ?? null,
          isEcho: Boolean(m.message.is_echo),
          timestamp: ts,
        });
      } else if (m.postback) {
        events.push({
          type: "postback",
          entryId,
          senderIgsid: String(m.sender?.id ?? ""),
          mid: m.postback.mid ?? null,
          payload: m.postback.payload ?? "",
          title: m.postback.title ?? null,
          timestamp: ts,
        });
      } else {
        events.push({ type: "other", entryId, field: m.read ? "read" : m.reaction ? "reaction" : null, timestamp: ts });
      }
    }

    for (const c of entry.changes ?? []) {
      const ts = (c.value?.created_time ?? entryTime) * (c.value?.created_time ? 1000 : 1);
      if (c.field === "comments" && c.value?.id) {
        events.push({
          type: "comment",
          entryId,
          commentId: String(c.value.id),
          mediaId: c.value.media?.id ? String(c.value.media.id) : null,
          text: c.value.text ?? null,
          fromId: c.value.from?.id ? String(c.value.from.id) : null,
          fromUsername: c.value.from?.username ?? null,
          timestamp: ts,
        });
      } else if (c.field === "leadgen" && c.value?.leadgen_id) {
        events.push({
          type: "leadgen",
          entryId,
          leadgenId: String(c.value.leadgen_id),
          formId: c.value.form_id ? String(c.value.form_id) : null,
          timestamp: ts,
        });
      } else {
        events.push({ type: "other", entryId, field: c.field ?? null, timestamp: entryTime });
      }
    }
  }
  return events;
}

/**
 * Deterministic dedupe key for at-least-once webhook delivery.
 * Messages dedupe on mid; comments on comment id; everything else on a
 * content hash of the entry.
 */
export function dedupeKeyForEvent(ev: NormalizedEvent): string {
  switch (ev.type) {
    case "message":
      return ev.mid ? `msg:${ev.mid}` : `msg:${sha256Hex(`${ev.senderIgsid}:${ev.timestamp}:${ev.text ?? ""}`)}`;
    case "postback":
      return ev.mid ? `pb:${ev.mid}` : `pb:${sha256Hex(`${ev.senderIgsid}:${ev.timestamp}:${ev.payload}`)}`;
    case "comment":
      return `cmt:${ev.commentId}`;
    case "leadgen":
      return `lead:${ev.leadgenId}`;
    case "other":
      return `oth:${sha256Hex(`${ev.entryId}:${ev.field}:${ev.timestamp}`)}`;
  }
}

/**
 * Dedupe key for one whole delivery (Meta batches several events into a single
 * POST). The joined per-event keys are HASHED rather than cut to a fixed width:
 * a prefix of a long batch is shared by every other batch that happens to start
 * with the same events, so a genuinely new delivery would be recognised as a
 * redelivery and silently dropped. Hashing also keeps the key inside the unique
 * index's row-size limit whatever the batch size.
 */
export function dedupeKeyForDelivery(events: readonly NormalizedEvent[], rawBody: string | Buffer): string {
  if (events.length === 0) return `raw:${sha256Hex(rawBody)}`;
  return `ev:${sha256Hex(events.map(dedupeKeyForEvent).join("|"))}`;
}
