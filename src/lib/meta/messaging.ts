import type { InstagramAccount } from "@prisma/client";
import { AppError } from "@/lib/errors";
import { graphCall } from "./client";
import { resolveAccess } from "./tokens";

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
  const access = await resolveAccess(account);
  return graphCall<{ id: string }>({
    host: access.host,
    method: "POST",
    path: `${commentId}/replies`,
    accessToken: access.accessToken,
    body: { message: text },
  });
}
