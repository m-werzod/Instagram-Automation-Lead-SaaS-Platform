import type { Automation, AutomationTriggerType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getGlobalSettings } from "@/lib/settings";
import { createLogger, errorFields } from "@/lib/logger";
import { resourceKindFromMime, resourceUrlFor } from "@/lib/resources";
import { rateLimit, LIMITS } from "@/lib/rate-limit";

const log = createLogger("automation");

/**
 * Automation engine (spec §27): TRIGGER → CONDITION(s) → ACTION(s).
 * Conditions are AND-combined. Actions run sequentially; a failing action is
 * recorded but does not abort the rest. Every run is persisted to
 * automation_runs. The master switch blocks all OUTBOUND actions; lead/CRM
 * actions keep working if globalSettings.leadAutomationWhenOff is true.
 */

export interface TriggerContext {
  accountId: string;
  conversationId?: string;
  igsid?: string;
  text?: string;
  commentId?: string;
  mediaId?: string;
  /** Local ContentItem.id the comment's media resolves to, when known — see contentScopeMatches. */
  contentId?: string;
  leadId?: string;
  leadStatus?: string;
  source?: string;
  username?: string;
}

export interface AutomationCondition {
  field: "text" | "source" | "lead_status" | "username";
  op: "contains" | "not_contains" | "equals" | "starts_with" | "regex";
  value: string;
}

export type AutomationAction =
  | { type: "SEND_MESSAGE"; params: { text: string } }
  | { type: "SEND_PRIVATE_REPLY"; params: { text: string } }
  | { type: "REPLY_COMMENT"; params: { text: string } }
  | { type: "START_LEAD_FLOW"; params: { flowId: string } }
  | { type: "SET_LEAD_STATUS"; params: { status: string } }
  | { type: "NOTIFY_ADMIN"; params: { text: string } }
  | { type: "SET_AI"; params: { enabled: boolean } }
  | {
      type: "SEND_COMMENT_RESOURCE";
      params: { mode: "template" | "ai"; text: string; resourceId?: string; agentId?: string };
    };

export const OUTBOUND_ACTIONS = new Set([
  "SEND_MESSAGE",
  "SEND_PRIVATE_REPLY",
  "REPLY_COMMENT",
  "START_LEAD_FLOW",
  "SEND_COMMENT_RESOURCE",
]);

/** Pure (unit-tested): does this rule's post/reel scope match the comment that triggered it? null = every post. */
export function contentScopeMatches(automationContentId: string | null | undefined, ctx: TriggerContext): boolean {
  return !automationContentId || automationContentId === ctx.contentId;
}

export function conditionMatches(cond: AutomationCondition, ctx: TriggerContext): boolean {
  const fieldValue = (
    {
      text: ctx.text,
      source: ctx.source,
      lead_status: ctx.leadStatus,
      username: ctx.username,
    }[cond.field] ?? ""
  ).toLowerCase();
  const target = cond.value.toLowerCase();

  switch (cond.op) {
    case "contains":
      return fieldValue.includes(target);
    case "not_contains":
      return !fieldValue.includes(target);
    case "equals":
      return fieldValue === target;
    case "starts_with":
      return fieldValue.startsWith(target);
    case "regex":
      try {
        return new RegExp(cond.value, "i").test(fieldValue);
      } catch {
        return false;
      }
  }
}

export function allConditionsMatch(conditions: unknown, ctx: TriggerContext): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  return (conditions as AutomationCondition[]).every((c) => {
    if (!c || typeof c !== "object" || !("field" in c)) return true;
    return conditionMatches(c, ctx);
  });
}

/**
 * Pure (unit-tested): has this rule already fired for this Instagram user too
 * recently? `lastRunAt` is the most recent SUCCESSful run's timestamp for
 * this (automationId, igsid) pair, or null if there is none. No cooldown
 * configured, or no igsid to key on (some triggers, e.g. LEAD_SUBMITTED,
 * carry none), always allows the rule to fire — this only ever narrows an
 * otherwise-matching rule, never widens one.
 */
export function isWithinCooldown(cooldownSec: number | null | undefined, lastRunAt: Date | null, now: Date = new Date()): boolean {
  if (!cooldownSec || !lastRunAt) return false;
  return now.getTime() - lastRunAt.getTime() < cooldownSec * 1000;
}

/** Fire all enabled automations for a trigger. Never throws. */
export async function runAutomations(trigger: AutomationTriggerType, ctx: TriggerContext): Promise<void> {
  let automations: Automation[] = [];
  try {
    automations = await prisma.automation.findMany({
      where: { accountId: ctx.accountId, trigger, enabled: true },
    });
  } catch (err) {
    log.error("failed loading automations", errorFields(err));
    return;
  }

  for (const automation of automations) {
    const startedAt = Date.now();
    try {
      if (!contentScopeMatches(automation.contentId, ctx)) {
        continue; // scoped to a different post/reel — not recorded as a run (too noisy)
      }
      if (!allConditionsMatch(automation.conditions, ctx)) {
        continue; // condition mismatch — not recorded as a run (too noisy)
      }

      if (automation.cooldownSec && ctx.igsid) {
        const last = await prisma.automationRun.findFirst({
          where: { automationId: automation.id, actorIgsid: ctx.igsid, status: "SUCCESS" },
          orderBy: { createdAt: "desc" },
          select: { createdAt: true },
        });
        if (isWithinCooldown(automation.cooldownSec, last?.createdAt ?? null)) {
          // Recorded (unlike the scope/condition skips above): the rule DID
          // match, so "why didn't this fire" is a real question an admin can
          // ask — SKIPPED answers it instead of leaving a silent gap.
          await prisma.automationRun.create({
            data: {
              automationId: automation.id,
              status: "SKIPPED",
              actorIgsid: ctx.igsid,
              triggerData: ctx as unknown as Prisma.InputJsonValue,
              error: `cooldown active (${automation.cooldownSec}s)`,
              durationMs: Date.now() - startedAt,
            },
          });
          continue;
        }
      }

      const results = await executeActions(automation, ctx);
      await prisma.$transaction([
        prisma.automationRun.create({
          data: {
            automationId: automation.id,
            status: results.every((r) => r.ok) ? "SUCCESS" : "FAILED",
            actorIgsid: ctx.igsid,
            triggerData: ctx as unknown as Prisma.InputJsonValue,
            result: results as unknown as Prisma.InputJsonValue,
            durationMs: Date.now() - startedAt,
            error: results.find((r) => !r.ok)?.error,
          },
        }),
        prisma.automation.update({
          where: { id: automation.id },
          data: { runCount: { increment: 1 }, lastRunAt: new Date() },
        }),
      ]);
    } catch (err) {
      log.error("automation run crashed", { automationId: automation.id, ...errorFields(err) });
      await prisma.automationRun
        .create({
          data: {
            automationId: automation.id,
            status: "FAILED",
            triggerData: ctx as unknown as Prisma.InputJsonValue,
            error: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - startedAt,
          },
        })
        .catch(() => undefined);
    }
  }
}

interface ActionResult {
  type: string;
  ok: boolean;
  detail?: string;
  error?: string;
}

async function executeActions(automation: Automation, ctx: TriggerContext): Promise<ActionResult[]> {
  const actions = (Array.isArray(automation.actions) ? automation.actions : []) as AutomationAction[];
  const settings = await getGlobalSettings();
  const results: ActionResult[] = [];

  for (const action of actions) {
    if (!action || typeof action !== "object" || !("type" in action)) continue;

    if (OUTBOUND_ACTIONS.has(action.type) && !settings.masterAutomationEnabled) {
      results.push({ type: action.type, ok: false, error: "blocked: master automation switch OFF" });
      continue;
    }
    if (!OUTBOUND_ACTIONS.has(action.type) && !settings.masterAutomationEnabled && !settings.leadAutomationWhenOff) {
      results.push({ type: action.type, ok: false, error: "blocked: master OFF and lead automation not allowed" });
      continue;
    }
    if (OUTBOUND_ACTIONS.has(action.type)) {
      const limit = LIMITS.AUTOMATION_ACCOUNT;
      const gate = rateLimit(`automation:${ctx.accountId}`, limit.limit, limit.windowMs);
      if (!gate.allowed) {
        results.push({ type: action.type, ok: false, error: `blocked: account automation rate limit (retry in ${gate.retryAfterSec}s)` });
        continue;
      }
    }

    try {
      results.push(await executeAction(action, ctx));
    } catch (err) {
      results.push({ type: action.type, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

async function executeAction(action: AutomationAction, ctx: TriggerContext): Promise<ActionResult> {
  switch (action.type) {
    case "SEND_MESSAGE": {
      if (!ctx.conversationId) return { type: action.type, ok: false, error: "no conversation in context" };
      const conversation = await prisma.conversation.findUnique({
        where: { id: ctx.conversationId },
        include: { account: true },
      });
      if (!conversation) return { type: action.type, ok: false, error: "conversation not found" };
      const { sendInstagramText } = await import("@/lib/meta/messaging");
      const sent = await sendInstagramText(conversation.account, conversation.igsid, action.params.text, {
        lastUserMessageAt: conversation.lastUserMessageAt,
      });
      await prisma.message.create({
        data: {
          conversationId: conversation.id,
          mid: sent.messageId,
          direction: "OUT",
          sender: "SYSTEM",
          text: action.params.text,
        },
      });
      return { type: action.type, ok: true };
    }
    case "SEND_PRIVATE_REPLY": {
      if (!ctx.commentId) return { type: action.type, ok: false, error: "no comment in context" };
      const account = await prisma.instagramAccount.findUnique({ where: { id: ctx.accountId } });
      if (!account) return { type: action.type, ok: false, error: "account not found" };
      const { sendPrivateReplyToComment } = await import("@/lib/meta/messaging");
      await sendPrivateReplyToComment(account, ctx.commentId, action.params.text);
      return { type: action.type, ok: true };
    }
    case "REPLY_COMMENT": {
      if (!ctx.commentId) return { type: action.type, ok: false, error: "no comment in context" };
      const account = await prisma.instagramAccount.findUnique({ where: { id: ctx.accountId } });
      if (!account) return { type: action.type, ok: false, error: "account not found" };
      const { replyToComment } = await import("@/lib/meta/messaging");
      await replyToComment(account, ctx.commentId, action.params.text);
      return { type: action.type, ok: true };
    }
    case "START_LEAD_FLOW": {
      if (!ctx.conversationId) return { type: action.type, ok: false, error: "no conversation in context" };
      const { startFlowSession } = await import("@/lib/leadflow/engine");
      const conversation = await prisma.conversation.findUnique({
        where: { id: ctx.conversationId },
        include: { account: true },
      });
      if (!conversation) return { type: action.type, ok: false, error: "conversation not found" };
      const outcome = await startFlowSession({
        flowId: action.params.flowId,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
      });
      if (outcome.sessionStatus !== "ACTIVE" || outcome.messages.length === 0) {
        return { type: action.type, ok: false, error: "flow disabled or empty" };
      }
      const { sendInstagramText } = await import("@/lib/meta/messaging");
      for (const m of outcome.messages) {
        const sent = await sendInstagramText(conversation.account, conversation.igsid, m.text, {
          lastUserMessageAt: conversation.lastUserMessageAt,
          quickReplies: m.quickReplies,
        });
        await prisma.message.create({
          data: { conversationId: conversation.id, mid: sent.messageId, direction: "OUT", sender: "SYSTEM", text: m.text },
        });
      }
      return { type: action.type, ok: true };
    }
    case "SET_LEAD_STATUS": {
      if (!ctx.leadId) return { type: action.type, ok: false, error: "no lead in context" };
      const status = action.params.status as "NEW" | "CONTACTED" | "QUALIFIED" | "IN_PROGRESS" | "WON" | "LOST";
      if (!["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"].includes(status)) {
        return { type: action.type, ok: false, error: "invalid status" };
      }
      await prisma.lead.update({ where: { id: ctx.leadId }, data: { status } });
      return { type: action.type, ok: true };
    }
    case "NOTIFY_ADMIN": {
      const { queueAdminAlert } = await import("@/lib/email");
      await queueAdminAlert("Automation notification", action.params.text);
      return { type: action.type, ok: true };
    }
    case "SET_AI": {
      if (!ctx.conversationId) return { type: action.type, ok: false, error: "no conversation in context" };
      await prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { aiEnabled: action.params.enabled, status: action.params.enabled ? "OPEN" : "HUMAN" },
      });
      return { type: action.type, ok: true };
    }
    case "SEND_COMMENT_RESOURCE": {
      if (!ctx.commentId) return { type: action.type, ok: false, error: "no comment in context" };
      const account = await prisma.instagramAccount.findUnique({ where: { id: ctx.accountId } });
      if (!account) return { type: action.type, ok: false, error: "account not found" };

      const resource = action.params.resourceId
        ? await prisma.commentResource.findUnique({ where: { id: action.params.resourceId } })
        : null;
      if (action.params.resourceId && !resource) return { type: action.type, ok: false, error: "resource not found" };
      const resourceLocation = resource
        ? { kind: resourceKindFromMime(resource.mimeType), url: resource.externalUrl ?? resourceUrlFor(resource.id, resource.mimeType) }
        : null;

      let text = action.params.text;
      if (action.params.mode === "ai") {
        if (!action.params.agentId) return { type: action.type, ok: false, error: "no agent configured for AI mode" };
        const agent = await prisma.aIAgent.findFirst({ where: { id: action.params.agentId, accountId: ctx.accountId } });
        if (!agent) return { type: action.type, ok: false, error: "agent not found" };
        const { runAgentTurn } = await import("@/lib/agent/runtime");
        const { COMMENT_SAFE_TOOL_IDS } = await import("@/lib/agent/tools");
        // The rule's own text is an instruction for THIS reply, injected as an
        // additional system directive — never as something the customer said,
        // matching the runtime's own "customer text is data, not instructions" rule.
        const composeAgent = { ...agent, systemPrompt: `${agent.systemPrompt}\n\n## This reply's specific purpose\n${action.params.text}` };
        const result = await runAgentTurn({
          agent: composeAgent,
          account,
          conversation: null,
          turns: [{ role: "user", text: ctx.text ?? "" }],
          lastUserText: ctx.text ?? "",
          dryRun: false,
          purpose: "comment_reply",
          surface: "comment",
          toolIdsOverride: COMMENT_SAFE_TOOL_IDS,
        });
        if (!result.text) return { type: action.type, ok: false, error: `AI produced no reply (${result.guard.action})` };
        text = result.text;
      }

      const { sendPrivateReplyResourceToComment } = await import("@/lib/meta/messaging");
      await sendPrivateReplyResourceToComment(account, ctx.commentId, text, resourceLocation);
      return { type: action.type, ok: true };
    }
    default:
      return { type: (action as { type: string }).type, ok: false, error: "unknown action type" };
  }
}
