import { prisma } from "@/lib/prisma";
import { registerHandler, enqueue } from "./index";
import { registerVideoHandlers } from "@/lib/video/jobs";
import { parseWebhookPayload, type NormalizedEvent, type WebhookPayload } from "@/lib/meta/webhooks";
import { runAutomations } from "@/lib/automation/engine";
import { generateAndSendReply, generateAndSendCommentReply } from "@/lib/agent/runtime";
import { getActiveSession, handleFlowAnswer, findFlowByKeyword, startFlowSession } from "@/lib/leadflow/engine";
import { sendInstagramText } from "@/lib/meta/messaging";
import { deliverEmailEvent, notifyLeadSubmitted } from "@/lib/email";
import { deliverLeadToTelegram } from "@/lib/telegram";
import { refreshExpiringTokens } from "@/lib/meta/accounts";
import { syncMedia } from "@/lib/meta/media";
import { touchLead } from "@/lib/leads";
import { runPublishJob } from "@/lib/meta/publishing";
import { syncCampaignFromMeta } from "@/lib/meta/marketing";
import { retryFailedPayments, runDueSchedules } from "@/lib/billing/service";
import { getGlobalSettings } from "@/lib/settings";
import { audit } from "@/lib/audit";
import { createLogger, errorFields } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

const log = createLogger("worker.handlers");

/**
 * Job handlers — imported by BOTH the worker process (scripts/worker.ts) and
 * the web process when QUEUE_INLINE=true. Registration is idempotent.
 */

// ---------- webhook.process ----------

registerHandler("webhook.process", async (payload) => {
  const webhookEventId = String(payload.webhookEventId ?? "");
  const event = await prisma.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!event || event.status === "PROCESSED") return;

  try {
    const events = parseWebhookPayload(event.payload as unknown as WebhookPayload);
    for (const ev of events) {
      await routeEvent(ev);
    }
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: "PROCESSED", processedAt: new Date(), error: null },
    });
  } catch (err) {
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { status: "FAILED", error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
});

async function routeEvent(ev: NormalizedEvent): Promise<void> {
  switch (ev.type) {
    case "message":
      return handleInboundMessage(ev);
    case "postback":
      return handleInboundMessage({
        type: "message",
        entryId: ev.entryId,
        senderIgsid: ev.senderIgsid,
        recipientId: ev.entryId,
        mid: ev.mid,
        text: ev.title ?? ev.payload,
        attachments: null,
        quickReplyPayload: ev.payload,
        isEcho: false,
        timestamp: ev.timestamp,
      });
    case "comment":
      return handleComment(ev);
    case "leadgen":
      await enqueue(
        "leadgen.fetch",
        { pageId: ev.entryId, leadgenId: ev.leadgenId, formId: ev.formId },
        { idempotencyKey: `leadgen:${ev.leadgenId}` },
      );
      return;
    case "other":
      return; // stored in webhook_events; nothing to do
  }
}

async function handleInboundMessage(ev: Extract<NormalizedEvent, { type: "message" }>): Promise<void> {
  // entry.id is the professional account's IG user id
  const account = await prisma.instagramAccount.findFirst({
    where: { OR: [{ igUserId: ev.entryId }, { igUserId: ev.recipientId }], status: "CONNECTED" },
  });
  if (!account) {
    log.warn("message for unknown account", { entryId: ev.entryId });
    return;
  }

  // Echoes = messages sent BY the professional account (possibly from the IG app).
  if (ev.isEcho || ev.senderIgsid === account.igUserId) {
    if (ev.mid) {
      const conversation = await prisma.conversation.findUnique({
        where: { accountId_igsid: { accountId: account.id, igsid: ev.recipientId } },
      });
      if (conversation) {
        await prisma.message
          .create({
            data: {
              conversationId: conversation.id,
              mid: ev.mid,
              direction: "OUT",
              sender: "ADMIN",
              text: ev.text,
              raw: { echo: true } as Prisma.InputJsonValue,
            },
          })
          .catch(() => undefined); // duplicate mid = we already stored our own send
      }
    }
    return;
  }

  const eventDate = new Date(ev.timestamp || Date.now());
  const conversation = await prisma.conversation.upsert({
    where: { accountId_igsid: { accountId: account.id, igsid: ev.senderIgsid } },
    create: {
      accountId: account.id,
      igsid: ev.senderIgsid,
      lastUserMessageAt: eventDate,
      lastMessageAt: eventDate,
      lastMessagePreview: ev.text?.slice(0, 140) ?? "[attachment]",
    },
    update: {
      lastUserMessageAt: eventDate,
      lastMessageAt: eventDate,
      lastMessagePreview: ev.text?.slice(0, 140) ?? "[attachment]",
    },
  });

  // store inbound message (mid-deduped)
  try {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        mid: ev.mid,
        direction: "IN",
        sender: "CUSTOMER",
        text: ev.text,
        attachments: ev.attachments as Prisma.InputJsonValue | undefined,
        quickReplyPayload: ev.quickReplyPayload,
      },
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      log.info("duplicate message mid ignored", { mid: ev.mid });
      return; // already processed this exact message
    }
    throw err;
  }

  if (conversation.leadId) await touchLead(conversation.leadId);

  // fire automations
  await runAutomations("MESSAGE_RECEIVED", {
    accountId: account.id,
    conversationId: conversation.id,
    igsid: ev.senderIgsid,
    text: ev.text ?? "",
  });

  const settings = await getGlobalSettings();
  const text = ev.text ?? "";

  // 1) active lead-flow session → the flow engine owns the message
  const session = await getActiveSession(conversation.id);
  if (session) {
    const allowFlow = settings.masterAutomationEnabled || settings.leadAutomationWhenOff;
    if (!allowFlow) return;
    const fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
    const outcome = await handleFlowAnswer(session, text, ev.quickReplyPayload);
    for (const m of outcome.messages) {
      try {
        const sent = await sendInstagramText(account, fresh.igsid, m.text, {
          lastUserMessageAt: fresh.lastUserMessageAt ?? eventDate,
          quickReplies: m.quickReplies,
        });
        await prisma.message.create({
          data: { conversationId: conversation.id, mid: sent.messageId, direction: "OUT", sender: "SYSTEM", text: m.text },
        });
      } catch (err) {
        log.error("flow message send failed", errorFields(err));
      }
    }
    if (outcome.sessionStatus === "COMPLETED") {
      const completedSession = await prisma.leadFlowSession.findUnique({
        where: { id: session.id },
        select: { leadId: true },
      });
      if (completedSession?.leadId) {
        await enqueue(
          "lead.process",
          { leadId: completedSession.leadId },
          { idempotencyKey: `lead.process:${completedSession.leadId}` },
        );
      }
    }
    return;
  }

  // 2) keyword-triggered lead flow start
  if (text && settings.masterAutomationEnabled) {
    const flowId = await findFlowByKeyword(account.id, text);
    if (flowId) {
      const outcome = await startFlowSession({ flowId, accountId: account.id, conversationId: conversation.id });
      for (const m of outcome.messages) {
        try {
          const sent = await sendInstagramText(account, conversation.igsid, m.text, {
            lastUserMessageAt: eventDate,
            quickReplies: m.quickReplies,
          });
          await prisma.message.create({
            data: { conversationId: conversation.id, mid: sent.messageId, direction: "OUT", sender: "SYSTEM", text: m.text },
          });
        } catch (err) {
          log.error("flow start send failed", errorFields(err));
        }
      }
      if (outcome.sessionStatus === "ACTIVE") return; // flow owns the conversation now
    }
  }

  // 3) AI agent reply
  const lastMessage = await prisma.message.findFirst({
    where: { conversationId: conversation.id, direction: "IN" },
    orderBy: { createdAt: "desc" },
  });
  await enqueue(
    "ai.reply",
    { conversationId: conversation.id, messageId: lastMessage?.id ?? "" },
    { idempotencyKey: lastMessage ? `ai.reply:${lastMessage.id}` : undefined, maxAttempts: 3 },
  );
}

/**
 * Comment side effects (a private reply, a DM) have no unique id to collide on
 * the way an inbound message has Message.mid, so Meta's at-least-once
 * redelivery — or a webhook.process retry after a LATER event in the same batch
 * threw — would send the commenter a second private reply. webhook_events is
 * this codebase's delivery-dedupe anchor (dedupeKey is unique), so a marker row
 * there settles the race in the database: whoever inserts it first owns this
 * comment. Returns false when someone already did.
 */
async function claimComment(commentId: string, accountId: string): Promise<boolean> {
  try {
    await prisma.webhookEvent.create({
      data: {
        object: "instagram",
        dedupeKey: `cmt:handled:${commentId}`,
        payload: { marker: "comment_handled", commentId, accountId } as Prisma.InputJsonValue,
        status: "PROCESSED",
        processedAt: new Date(),
      },
    });
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      return false;
    }
    throw err;
  }
}

async function handleComment(ev: Extract<NormalizedEvent, { type: "comment" }>): Promise<void> {
  const account = await prisma.instagramAccount.findFirst({
    where: { igUserId: ev.entryId, status: "CONNECTED" },
  });
  if (!account) return;
  // never react to our own comments
  if (ev.fromId && ev.fromId === account.igUserId) return;

  // Same position as the message path's mid guard: before anything that sends.
  if (!(await claimComment(ev.commentId, account.id))) {
    log.info("duplicate comment ignored", { commentId: ev.commentId });
    return;
  }

  // Resolve Meta's media id to our local ContentItem so rules can be scoped to
  // one specific post/reel. A post the platform hasn't synced yet simply has
  // no match — account-wide rules (contentId: null) still fire normally.
  const content = ev.mediaId
    ? await prisma.contentItem.findUnique({ where: { accountId_mediaId: { accountId: account.id, mediaId: ev.mediaId } } })
    : null;

  // Independent of each other, same as MESSAGE_RECEIVED automations vs. ai.reply
  // below: a static rule and the AI comment-reply agent may both react to the
  // same comment — one privately (resource rules), one publicly (AI reply).
  await runAutomations("COMMENT_RECEIVED", {
    accountId: account.id,
    commentId: ev.commentId,
    mediaId: ev.mediaId ?? undefined,
    contentId: content?.id,
    text: ev.text ?? "",
    username: ev.fromUsername ?? undefined,
    // Same igsid space Meta uses for messaging — lets a rule's cooldown (if
    // configured) recognize "this is the same commenter" across comments.
    igsid: ev.fromId ?? undefined,
  });

  await enqueue(
    "comment.ai_reply",
    { accountId: account.id, commentId: ev.commentId, text: ev.text ?? "" },
    { idempotencyKey: `comment.ai_reply:${ev.commentId}`, maxAttempts: 3 },
  );
}

// ---------- ai.reply ----------

registerHandler("ai.reply", async (payload) => {
  const conversationId = String(payload.conversationId ?? "");
  if (!conversationId) return;
  const outcome = await generateAndSendReply(conversationId, String(payload.messageId ?? ""));
  log.info("ai.reply outcome", { conversationId, ...outcome });

  // The agent handing a conversation to a human is the same event an admin's
  // manual takeover is, so CONVERSATION_HANDOFF rules (alert the team, tag the
  // lead) must fire here too — the takeover endpoint used to be the only path
  // that fired them, and the AI path is the one that happens unattended.
  if (outcome.action === "handed_off") {
    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { accountId: true, igsid: true },
    });
    if (conversation) {
      await runAutomations("CONVERSATION_HANDOFF", {
        accountId: conversation.accountId,
        conversationId,
        igsid: conversation.igsid,
      });
    }
  }
});

// ---------- comment.ai_reply ----------

/**
 * Ceiling on PUBLIC AI comment replies for one Instagram ACCOUNT per hour.
 * Distinct from an agent's per-user DM cap: one viral post produces hundreds of
 * comments from hundreds of different people, and every reply is visible under
 * the account's own post. Counted from the audit row each SENT reply writes, so
 * a skipped or blocked attempt never consumes another commenter's slot, and the
 * count is shared by every worker/lambda and survives a restart.
 *
 * This is the OUTER of two ceilings today: generateAndSendCommentReply still
 * applies the agent's per-user DM field (maxRepliesPerUserPerHour, default 20)
 * account-wide over AIUsage ATTEMPT rows, so that inner one usually binds first.
 * Removing it belongs in src/lib/agent/runtime.ts, not here.
 */
const COMMENT_AI_REPLY_ACCOUNT_HOURLY_CAP = 60;
/** Written per sent public AI comment reply — the cap counts these. */
const AI_COMMENT_REPLY_SENT = "AI_COMMENT_REPLY_SENT";

registerHandler("comment.ai_reply", async (payload) => {
  const accountId = String(payload.accountId ?? "");
  const commentId = String(payload.commentId ?? "");
  if (!accountId || !commentId) return;

  const sentLastHour = await prisma.auditLog.count({
    where: {
      action: AI_COMMENT_REPLY_SENT,
      resourceType: "instagram_account",
      resourceId: accountId,
      createdAt: { gte: new Date(Date.now() - 3600_000) },
    },
  });
  if (sentLastHour >= COMMENT_AI_REPLY_ACCOUNT_HOURLY_CAP) {
    log.warn("comment.ai_reply skipped: account hourly reply cap reached", {
      accountId,
      commentId,
      sentLastHour,
      cap: COMMENT_AI_REPLY_ACCOUNT_HOURLY_CAP,
    });
    return;
  }

  const outcome = await generateAndSendCommentReply(accountId, commentId, String(payload.text ?? ""));
  log.info("comment.ai_reply outcome", { accountId, commentId, ...outcome });
  if (outcome.action === "replied") {
    await audit({
      action: AI_COMMENT_REPLY_SENT,
      resourceType: "instagram_account",
      resourceId: accountId,
      after: { commentId },
    });
  }
});

// ---------- lead.process ----------

registerHandler("lead.process", async (payload) => {
  const leadId = String(payload.leadId ?? "");
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { account: true } });
  if (!lead) return;

  // Telegram is the primary receiver; it runs as its OWN job so a Telegram
  // outage never blocks (or double-sends) the email path, and vice versa.
  await enqueue("telegram.send", { leadId: lead.id }, { maxAttempts: 5 });
  await notifyLeadSubmitted(lead, lead.account);
  await runAutomations("LEAD_SUBMITTED", {
    accountId: lead.accountId,
    leadId: lead.id,
    conversationId: lead.conversationId ?? undefined,
    leadStatus: lead.status,
    source: lead.source,
    text: lead.name ?? "",
  });
});

// ---------- telegram.send ----------

registerHandler("telegram.send", async (payload) => {
  const leadId = String(payload.leadId ?? "");
  if (!leadId) return;
  await deliverLeadToTelegram(leadId);
});

// ---------- email.send ----------

registerHandler("email.send", async (payload) => {
  const emailEventId = String(payload.emailEventId ?? "");
  if (!emailEventId) return;
  await deliverEmailEvent(emailEventId);
});

// ---------- leadgen.fetch (Instant Form lead ads) ----------

registerHandler("leadgen.fetch", async (payload) => {
  const leadgenId = String(payload.leadgenId ?? "");
  const pageId = String(payload.pageId ?? "");
  const account = await prisma.instagramAccount.findFirst({ where: { fbPageId: pageId, status: "CONNECTED" } });
  if (!account || !leadgenId) return;

  const { getActiveToken } = await import("@/lib/meta/tokens");
  const pageToken = await getActiveToken(account.id, "page");
  if (!pageToken) throw new Error("Page token missing for leadgen fetch");

  const { graphCall } = await import("@/lib/meta/client");
  const leadData = await graphCall<{
    id: string;
    created_time?: string;
    field_data?: Array<{ name: string; values: string[] }>;
    campaign_id?: string;
  }>({
    host: "graph.facebook.com",
    path: leadgenId,
    accessToken: pageToken.token,
    params: { fields: "id,created_time,field_data,campaign_id" },
  });

  const fields = new Map((leadData.field_data ?? []).map((f) => [f.name.toLowerCase(), f.values?.[0] ?? ""]));
  const answers = (leadData.field_data ?? []).map((f) => ({ question: f.name, answer: f.values?.join(", ") ?? "" }));
  const localCampaign = leadData.campaign_id
    ? await prisma.campaign.findFirst({ where: { metaCampaignId: leadData.campaign_id } })
    : null;

  const existing = await prisma.lead.findFirst({
    where: { accountId: account.id, source: "lead_ad", answers: { path: ["leadgenId"], equals: leadgenId } },
  });
  if (existing) return;

  const lead = await prisma.lead.create({
    data: {
      accountId: account.id,
      name: fields.get("full_name") ?? fields.get("full name") ?? null,
      phone: fields.get("phone_number") ?? fields.get("phone") ?? null,
      email: fields.get("email") ?? null,
      answers: { leadgenId, items: answers } as Prisma.InputJsonValue,
      source: "lead_ad",
      campaignId: localCampaign?.id ?? null,
      status: "NEW",
    },
  });
  await prisma.leadEvent.create({ data: { leadId: lead.id, type: "CREATED", data: { leadgenId } } });
  await enqueue("lead.process", { leadId: lead.id }, { idempotencyKey: `lead.process:${lead.id}` });
});

// ---------- publish.run (Instagram content publishing) ----------

registerHandler("publish.run", async (payload) => {
  const publishJobId = String(payload.publishJobId ?? "");
  if (!publishJobId) return;
  await runPublishJob(publishJobId);
});

// ---------- periodic: token refresh ----------

registerHandler("tokens.refresh", async () => {
  const result = await refreshExpiringTokens();
  log.info("token refresh sweep", result);
});

// ---------- periodic: media/analytics sync ----------

registerHandler("analytics.sync", async (payload) => {
  const accountId = payload.accountId ? String(payload.accountId) : null;
  const accounts = accountId
    ? await prisma.instagramAccount.findMany({ where: { id: accountId, status: "CONNECTED", isDemo: false } })
    : await prisma.instagramAccount.findMany({ where: { status: "CONNECTED", isDemo: false } });
  for (const account of accounts) {
    try {
      const count = await syncMedia(account, 50);
      log.info("media synced", { accountId: account.id, count });
    } catch (err) {
      log.warn("media sync failed", { accountId: account.id, ...errorFields(err) });
    }
  }
});

// ---------- periodic: campaign status + spend from Meta ----------

registerHandler("campaigns.sync", async (payload) => {
  const campaignId = payload.campaignId ? String(payload.campaignId) : null;
  const campaigns = await prisma.campaign.findMany({
    where: campaignId
      ? { id: campaignId }
      : { status: { in: ["ACTIVE", "PAUSED", "CREATED"] }, metaCampaignId: { not: null }, account: { isDemo: false, status: "CONNECTED" } },
    include: { account: true },
    take: 100,
  });
  for (const campaign of campaigns) {
    try {
      await syncCampaignFromMeta(campaign.account, campaign);
    } catch (err) {
      log.warn("campaign sync failed", { campaignId: campaign.id, ...errorFields(err) });
    }
  }
});

// ---------- periodic: billing (automatic payments + retries) ----------

registerHandler("billing.schedules", async () => {
  const result = await runDueSchedules();
  log.info("billing schedules run", result);
});

registerHandler("billing.retry", async () => {
  const result = await retryFailedPayments();
  log.info("billing retry run", result);
});

// ---------- periodic: queue cleanup ----------

registerHandler("queue.cleanup", async () => {
  const completed = await prisma.job.deleteMany({
    where: { status: "COMPLETED", updatedAt: { lt: new Date(Date.now() - 7 * 86400_000) } },
  });
  const dead = await prisma.job.deleteMany({
    where: { status: "DEAD", updatedAt: { lt: new Date(Date.now() - 30 * 86400_000) } },
  });
  const oldEvents = await prisma.webhookEvent.deleteMany({
    where: { status: "PROCESSED", receivedAt: { lt: new Date(Date.now() - 30 * 86400_000) } },
  });
  log.info("queue cleanup", { completedDeleted: completed.count, deadDeleted: dead.count, webhookEventsDeleted: oldEvents.count });
});

/** Seed hourly/daily periodic jobs (idempotent via time-bucketed keys). */
export async function ensurePeriodicJobs(): Promise<void> {
  const now = new Date();
  const hourKey = now.toISOString().slice(0, 13); // yyyy-mm-ddThh
  const dayKey = now.toISOString().slice(0, 10);
  await enqueue("tokens.refresh", {}, { idempotencyKey: `tokens.refresh:${hourKey}` });
  await enqueue("analytics.sync", {}, { idempotencyKey: `analytics.sync:${dayKey}` });
  await enqueue("campaigns.sync", {}, { idempotencyKey: `campaigns.sync:${hourKey}` });
  await enqueue("billing.schedules", {}, { idempotencyKey: `billing.schedules:${hourKey}` });
  await enqueue("billing.retry", {}, { idempotencyKey: `billing.retry:${hourKey}` });
  await enqueue("queue.cleanup", {}, { idempotencyKey: `queue.cleanup:${dayKey}` });
}

// Video renders live in their own module (and their own queue lane); registering
// them here keeps "import the handlers file" the single way a process becomes a
// worker, whatever kind of work it can do.
registerVideoHandlers();
