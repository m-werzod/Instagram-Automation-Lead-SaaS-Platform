import type { AIAgent, Conversation, InstagramAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { retrieveKnowledge } from "@/lib/knowledge";
import { startFlowSession } from "@/lib/leadflow/engine";
import { createLogger } from "@/lib/logger";
import type { ToolDef } from "@/lib/ai";

const log = createLogger("agent.tools");

/**
 * Agent tool layer (spec §34–35). Every tool has a risk tier; an agent can
 * only call tools explicitly enabled in agent.allowedTools, and HIGH_RISK
 * tools additionally never execute side effects that spend money or publish
 * content — they only create drafts for admin review.
 */

export type ToolRisk = "READ" | "WRITE" | "HIGH_RISK";

export interface ToolContext {
  account: InstagramAccount;
  agent: AIAgent;
  conversation: Conversation;
}

export interface ToolResult {
  /** string fed back to the model */
  output: string;
  /** signals to the runtime */
  effects?: {
    startedFlowMessages?: Array<{ text: string; quickReplies?: Array<{ title: string; payload: string }> }>;
    handedOff?: boolean;
    suppressReply?: boolean;
  };
}

export interface AgentTool {
  id: string;
  risk: ToolRisk;
  def: ToolDef;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : "";
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    id: "get_business_knowledge",
    risk: "READ",
    def: {
      name: "get_business_knowledge",
      description:
        "Search the business knowledge base (prices, services, schedules, policies, addresses). ALWAYS use this before answering questions about facts you are not certain about.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to look up" } },
        required: ["query"],
      },
    },
    async execute(args, ctx) {
      const query = str(args, "query");
      if (!ctx.agent.knowledgeEnabled) {
        return { output: "Knowledge base is disabled for this agent." };
      }
      const chunks = await retrieveKnowledge(ctx.account.id, ctx.agent.id, query, 4);
      if (chunks.length === 0) {
        return {
          output:
            "No knowledge found for this query. Tell the user honestly that you don't have that information and offer to connect them with a human.",
        };
      }
      return {
        output: chunks.map((c, i) => `[${i + 1}] (${c.documentTitle})\n${c.text}`).join("\n\n"),
      };
    },
  },
  {
    id: "start_lead_flow",
    risk: "WRITE",
    def: {
      name: "start_lead_flow",
      description:
        "Start the structured registration/lead questionnaire in this conversation. Use when the user wants to sign up, register, book, or leave contact details. After calling this, do NOT write your own reply — the flow sends its first question automatically.",
      parameters: { type: "object", properties: {}, required: [] },
    },
    async execute(_args, ctx) {
      const flowId = ctx.agent.defaultLeadFlowId;
      if (!flowId) {
        return { output: "No lead flow is configured for this agent. Collect name and phone conversationally instead." };
      }
      const outcome = await startFlowSession({
        flowId,
        accountId: ctx.account.id,
        conversationId: ctx.conversation.id,
      });
      if (outcome.sessionStatus !== "ACTIVE") {
        return { output: "The lead flow could not be started (disabled or empty)." };
      }
      return {
        output: "Lead flow started — the first question is being sent to the user. Do not send another message.",
        effects: { startedFlowMessages: outcome.messages, suppressReply: true },
      };
    },
  },
  {
    id: "create_lead",
    risk: "WRITE",
    def: {
      name: "create_lead",
      description:
        "Create a CRM lead with details the user already shared in conversation (only use values the user actually stated).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          note: { type: "string", description: "Context: what the user is interested in" },
        },
        required: [],
      },
    },
    async execute(args, ctx) {
      const name = str(args, "name") || ctx.conversation.username || null;
      const phone = str(args, "phone") || null;
      const email = str(args, "email") || null;
      if (!name && !phone && !email) {
        return { output: "Refused: no contact details provided. Ask the user for at least a name or phone number." };
      }
      const lead = await prisma.lead.create({
        data: {
          accountId: ctx.account.id,
          igsid: ctx.conversation.igsid,
          conversationId: ctx.conversation.id,
          name,
          phone,
          email,
          notes: str(args, "note") || null,
          source: "instagram_dm",
          status: "NEW",
        },
      });
      await prisma.leadEvent.create({ data: { leadId: lead.id, type: "CREATED", data: { by: "ai_agent" } } });
      await prisma.conversation.update({ where: { id: ctx.conversation.id }, data: { leadId: lead.id } });
      const { enqueue } = await import("@/lib/queue");
      await enqueue("lead.process", { leadId: lead.id }, { idempotencyKey: `lead.process:${lead.id}` });
      log.info("agent created lead", { leadId: lead.id, agentId: ctx.agent.id });
      return { output: `Lead created (id ${lead.id}). The team has been notified.` };
    },
  },
  {
    id: "update_lead_status",
    risk: "WRITE",
    def: {
      name: "update_lead_status",
      description: "Update the status of the lead attached to this conversation (e.g. after qualifying them).",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"] },
        },
        required: ["status"],
      },
    },
    async execute(args, ctx) {
      const status = str(args, "status") as "NEW" | "CONTACTED" | "QUALIFIED" | "IN_PROGRESS" | "WON" | "LOST";
      if (!["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"].includes(status)) {
        return { output: "Invalid status." };
      }
      if (!ctx.conversation.leadId) return { output: "No lead is attached to this conversation yet." };
      await prisma.lead.update({ where: { id: ctx.conversation.leadId }, data: { status } });
      await prisma.leadEvent.create({
        data: { leadId: ctx.conversation.leadId, type: "STATUS_CHANGED", data: { status, by: "ai_agent" } },
      });
      return { output: `Lead status updated to ${status}.` };
    },
  },
  {
    id: "handoff_to_human",
    risk: "WRITE",
    def: {
      name: "handoff_to_human",
      description:
        "Escalate this conversation to a human admin (complaints, complex cases, explicit requests for a human, or anything outside your rules). AI auto-replies stop after this.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
    async execute(args, ctx) {
      if (!ctx.agent.humanHandoffEnabled) {
        return { output: "Human handoff is disabled for this agent; continue assisting as best you can." };
      }
      await prisma.conversation.update({
        where: { id: ctx.conversation.id },
        data: { status: "HUMAN", aiEnabled: false },
      });
      const { queueAdminAlert } = await import("@/lib/email");
      await queueAdminAlert(
        `Conversation handed off to human (@${ctx.account.username})`,
        `The AI agent "${ctx.agent.name}" escalated a conversation.\nReason: ${str(args, "reason")}\nOpen the Conversations page to respond.`,
      );
      const { audit } = await import("@/lib/audit");
      await audit({
        action: "AI_HANDOFF_TO_HUMAN",
        resourceType: "conversation",
        resourceId: ctx.conversation.id,
        after: { reason: str(args, "reason") },
      });
      return {
        output:
          "Conversation escalated to a human admin. Send ONE short final message telling the user a team member will reply soon.",
        effects: { handedOff: true },
      };
    },
  },
  {
    id: "do_not_reply",
    risk: "READ",
    def: {
      name: "do_not_reply",
      description:
        "Choose not to send any reply (spam, abusive content with no question, or a message that needs no response).",
      parameters: { type: "object", properties: { reason: { type: "string" } }, required: [] },
    },
    async execute(args) {
      return { output: `No reply will be sent. (${str(args, "reason")})`, effects: { suppressReply: true } };
    },
  },
  {
    id: "create_campaign_draft",
    risk: "HIGH_RISK",
    def: {
      name: "create_campaign_draft",
      description:
        "Create a LOCAL DRAFT advertising campaign recommendation for admin review. This never spends money and never publishes anything — an admin must review and publish it manually.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          objective: { type: "string", enum: ["OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_AWARENESS"] },
          dailyBudgetUsd: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["name", "objective", "rationale"],
      },
    },
    async execute(args, ctx) {
      const budget = typeof args.dailyBudgetUsd === "number" ? Math.round(args.dailyBudgetUsd * 100) : 500;
      const campaign = await prisma.campaign.create({
        data: {
          accountId: ctx.account.id,
          name: str(args, "name").slice(0, 120) || "AI campaign draft",
          objective: str(args, "objective") || "OUTCOME_TRAFFIC",
          status: "DRAFT",
          dailyBudgetCents: Math.min(budget, 10_000), // AI drafts capped at $100/day
          createdByAi: true,
          creativeSpec: { rationale: str(args, "rationale") },
        },
      });
      log.info("agent created campaign draft", { campaignId: campaign.id });
      return {
        output: `Draft campaign "${campaign.name}" created for admin review (id ${campaign.id}). It is NOT running and no budget is being spent.`,
      };
    },
  },
];

export const TOOLS_BY_ID = new Map(AGENT_TOOLS.map((t) => [t.id, t]));

/** Default allowed set for new agents — safe tiers only. */
export const DEFAULT_ALLOWED_TOOLS = [
  "get_business_knowledge",
  "start_lead_flow",
  "create_lead",
  "update_lead_status",
  "handoff_to_human",
  "do_not_reply",
];

export function resolveAgentTools(agent: AIAgent): AgentTool[] {
  const allowed = new Set(agent.allowedTools);
  return AGENT_TOOLS.filter((t) => allowed.has(t.id));
}
