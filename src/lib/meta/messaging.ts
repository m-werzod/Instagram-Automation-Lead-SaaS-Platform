import type { InstagramAccount } from "@prisma/client";
import { AppError } from "@/lib/errors";
import { graphCall } from "./client";
import { resolveAccess } from "./tokens";
import type { ResourceKind } from "@/lib/resources";

/**
 * Instagram DM send layer (Messaging API v25.0 — see docs/META_API.md §3).
 * Enforces the 24-hour customer-service window: automated sends outside the
 * window are refused HERE, not left to Meta to reject.
 */

export const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Meta limit: 13 quick replies, 20 chars each. */
export const MAX_QUICK_REPLIES = 13;
export const MAX_QUICK_REPLY_TITLE = 20;
/** Text messages are capped at 1000 bytes UTF-8. */
export const MAX_TEXT_BYTES = 1000;

export interface QuickReply {
  title: string;
  payload: string;
}

export interface SendResult {
  recipientId: string;
  messageId: string;
}

export function isWithinMessagingWindow(lastUserMessageAt: Date | null | undefined): boolean {
  if (!lastUserMessageAt) return false;
  return Date.now() - lastUserMessageAt.getTime() < MESSAGING_WINDOW_MS;
}

/** Truncate to the UTF-8 byte budget without splitting a code point. */
export function clampTextBytes(text: string, maxBytes = MAX_TEXT_BYTES): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= maxBytes) return text;
  let out = text;
  while (enc.encode(out + "…").length > maxBytes && out.length > 0) {
    out = out.slice(0, -1);
  }
  return out + "…";
}

interface SendOpts {
  /** Window enforcement context; REQUIRED for automated sends. */
  lastUserMessageAt: Date | null;
  /** Human agent sends within 7 days may use the tag if the app has approval. */
  humanAgentTag?: boolean;
  quickReplies?: QuickReply[];
}

export async function sendInstagramText(
  account: InstagramAccount,
  recipientIgsid: string,
  text: string,
  opts: SendOpts,
): Promise<SendResult> {
  if (!opts.humanAgentTag && !isWithinMessagingWindow(opts.lastUserMessageAt)) {
    throw new AppError("META_UNSUPPORTED", "Cannot send: outside the 24-hour messaging window", {
      reason:
        "Meta only allows sending a DM within 24h of the user's last message (docs/META_API.md §3). The user has not messaged recently.",
      fix: "Wait for the user to message again, or (human admins only, if the app has Human Agent approval) use the human-agent send option within 7 days.",
    });
  }

  const message: Record<string, unknown> = { text: clampTextBytes(text) };
  if (opts.quickReplies && opts.quickReplies.length > 0) {
    message.quick_replies = opts.quickReplies.slice(0, MAX_QUICK_REPLIES).map((qr) => ({
      content_type: "text",
      title: qr.title.slice(0, MAX_QUICK_REPLY_TITLE),
      payload: qr.payload.slice(0, 1000),
    }));
  }

  const body: Record<string, unknown> = {
    recipient: { id: recipientIgsid },
    message,
  };
  if (opts.humanAgentTag) {
    body.messaging_type = "MESSAGE_TAG";
    body.tag = "HUMAN_AGENT";
  } else {
    body.messaging_type = "RESPONSE";
  }

  return sendRaw(account, body);
}

/** Private reply: DM sent in response to a comment (allowed within 7 days of the comment). */
export async function sendPrivateReplyToComment(
  account: InstagramAccount,
  commentId: string,
  text: string,
): Promise<SendResult> {
  return sendRaw(account, {
    recipient: { comment_id: commentId },
    message: { text: clampTextBytes(text) },
  });
}

export interface PrivateReplyPayload {
  /** The single Send API `message` object this private reply may carry. */
  message: Record<string, unknown>;
  /** Caption that could NOT travel with it — reported, never silently dropped. */
  omittedText: string | null;
  /** Why it could not, in words an admin can act on. null when nothing was omitted. */
  omittedReason: string | null;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Pure (unit-tested): the ONE message a resource + caption may become.
 *
 * Meta allows a single private reply per comment (docs/META_API.md §3) and the
 * Send API's message object takes `attachment` OR `text`, never both — so a
 * caption sent as a second call is not "the caption arriving late", it is a
 * guaranteed rejection. The caption is therefore folded in wherever the text
 * IS the message, and reported as omitted when a native attachment takes the
 * one reply slot.
 *
 * Meta's Send API documents image/video/audio attachment TYPES only — there is
 * no generic "file" attachment (unlike Messenger) — so an IMAGE/VIDEO resource
 * attaches natively and anything else (PDF, docs) sends as a link inside the
 * text, which is also how its caption survives. Never faked as a real
 * attachment when it isn't one.
 */
export function buildPrivateReplyMessage(
  text: string,
  resource: { kind: ResourceKind; url: string } | null,
): PrivateReplyPayload {
  if (!resource) {
    return { message: { text: clampTextBytes(text) }, omittedText: null, omittedReason: null };
  }
  if (resource.kind === "FILE") {
    // The link IS the delivery here, and it sits at the END of the joined text —
    // exactly where the 1000-byte clamp cuts. A caption well inside its 900-CHAR
    // limit is already over the BYTE budget in Uzbek/Russian, which posted a
    // truncated sentence and a dead "https…" stub. So the link is reserved
    // first and only the caption gives ground.
    const tail = `\n\n${resource.url}`;
    const budget = MAX_TEXT_BYTES - utf8Bytes(tail);
    const clamped = budget > 0 ? clampTextBytes(text.trim(), budget) : "";
    // A long externalUrl (admin-pasted, tracking params and all) can leave room
    // for the ellipsis and nothing else — that is an omitted caption, not a sent one.
    const caption = clamped === "…" ? "" : clamped;
    return {
      message: { text: `${caption}${tail}`.trim() },
      omittedText: caption ? null : text.trim() || null,
      omittedReason: caption || !text.trim() ? null : "the file link alone fills Instagram's 1000-byte message limit",
    };
  }
  const attachmentType = resource.kind === "IMAGE" ? "image" : "video";
  return {
    message: { attachment: { type: attachmentType, payload: { url: resource.url, is_reusable: false } } },
    omittedText: text.trim() || null,
    omittedReason: text.trim()
      ? "Instagram allows one private reply per comment, and an attachment message cannot carry text"
      : null,
  };
}

/** Private reply carrying a resource (comment-resource automations) — see buildPrivateReplyMessage(). */
export async function sendPrivateReplyResourceToComment(
  account: InstagramAccount,
  commentId: string,
  text: string,
  resource: { kind: ResourceKind; url: string } | null,
): Promise<{ result: SendResult; omittedText: string | null; omittedReason: string | null }> {
  const payload = buildPrivateReplyMessage(text, resource);
  const result = await sendRaw(account, { recipient: { comment_id: commentId }, message: payload.message });
  return { result, omittedText: payload.omittedText, omittedReason: payload.omittedReason };
}

async function sendRaw(account: InstagramAccount, body: Record<string, unknown>): Promise<SendResult> {
  // Demo accounts never call Meta — messages only exist in the local DB so the
  // whole pipeline (flows, AI, CRM) is testable without a Meta app.
  if (account.isDemo) {
    return {
      recipientId: String((body.recipient as { id?: string })?.id ?? "demo"),
      messageId: `demo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }
  const access = await resolveAccess(account);
  const path =
    account.connectionMode === "INSTAGRAM_LOGIN" ? `${account.igUserId}/messages` : `me/messages`;

  const res = await graphCall<{ recipient_id: string; message_id: string }>({
    host: access.host,
    method: "POST",
    path,
    accessToken: access.accessToken,
    body,
  });
  return { recipientId: res.recipient_id, messageId: res.message_id };
}

/** Reply publicly to a comment. */
export async function replyToComment(account: InstagramAccount, commentId: string, text: string) {
  // Same rule as sendRaw: a demo account never reaches Meta, and a public
  // comment reply is the most visible send of all.
  if (account.isDemo) return { id: `demo-reply-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
  const access = await resolveAccess(account);
  return graphCall<{ id: string }>({
    host: access.host,
    method: "POST",
    path: `${commentId}/replies`,
    accessToken: access.accessToken,
    body: { message: text },
  });
}
