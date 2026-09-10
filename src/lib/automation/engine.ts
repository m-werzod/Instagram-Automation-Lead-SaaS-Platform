import type { Automation, AutomationTriggerType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getGlobalSettings } from "@/lib/settings";
import { createLogger, errorFields } from "@/lib/logger";

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
  | { type: "SET_AI"; params: { enabled: boolean } };

export const OUTBOUND_ACTIONS = new Set(["SEND_MESSAGE", "SEND_PRIVATE_REPLY", "REPLY_COMMENT", "START_LEAD_FLOW"]);

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
      if (!allConditionsMatch(automation.conditions, ctx)) {
        continue; // condition mismatch — not recorded as a run (too noisy)
      }
      const results = await executeActions(automation, ctx);
      await prisma.$transaction([
        prisma.automationRun.create({
          data: {
            automationId: automation.id,
            status: results.every((r) => r.ok) ? "SUCCESS" : "FAILED",
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
    default:
      return { type: (action as { type: string }).type, ok: false, error: "unknown action type" };
  }
}
