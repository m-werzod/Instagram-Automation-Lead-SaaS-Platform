import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { TOOLS_BY_ID } from "@/lib/agent/tools";
import { HHMM } from "@/lib/agent/guardrails";
import { aiRuntimeInfo, isProviderConfigured } from "@/lib/ai";
import { Prisma } from "@prisma/client";

export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const agent = await prisma.aIAgent.findUnique({
    where: { id },
    include: {
      account: { select: { id: true, username: true } },
      documents: { select: { id: true, title: true, status: true } },
    },
  });
  if (!agent) throw notFound("Agent");
  await assertAccountAccess(auth, agent.accountId);
  const since = new Date(Date.now() - 30 * 86400_000);
  const [flows, usageAgg, failures, recentErrors] = await Promise.all([
    prisma.leadFlow.findMany({ where: { accountId: agent.accountId }, select: { id: true, name: true, enabled: true } }),
    prisma.aIUsage.aggregate({
      where: { agentId: id, createdAt: { gte: since } },
      _count: true,
      _sum: { inputTokens: true, outputTokens: true, costUsd: true },
      _avg: { latencyMs: true },
    }),
    prisma.aIUsage.count({ where: { agentId: id, createdAt: { gte: since }, success: false } }),
    prisma.aIUsage.findMany({
      where: { agentId: id, success: false },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { error: true, createdAt: true, purpose: true, model: true },
    }),
  ]);
  return ok({
    agent,
    flows,
    providerConfigured: isProviderConfigured(agent.provider),
    runtime: aiRuntimeInfo(),
    usage: {
      days: 30,
      calls: usageAgg._count,
      failures,
      inputTokens: usageAgg._sum.inputTokens ?? 0,
      outputTokens: usageAgg._sum.outputTokens ?? 0,
      costUsd: usageAgg._sum.costUsd ?? 0,
      avgLatencyMs: usageAgg._avg.latencyMs ? Math.round(usageAgg._avg.latencyMs) : null,
    },
    recentErrors,
  });
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  provider: z.enum(["ANTHROPIC", "OPENAI", "GOOGLE"]).optional(),
  model: z.string().min(1).max(100).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(8192).optional(),
  systemPrompt: z.string().min(10).max(20000).optional(),
  tone: z.string().max(200).nullable().optional(),
  language: z.string().max(60).nullable().optional(),
  businessContext: z.string().max(30000).nullable().optional(),
  salesStrategy: z.string().max(10000).nullable().optional(),
  conversationRules: z.string().max(10000).nullable().optional(),
  escalationRules: z.string().max(10000).nullable().optional(),
  autoReply: z.boolean().optional(),
  leadQualification: z.boolean().optional(),
  knowledgeEnabled: z.boolean().optional(),
  humanHandoffEnabled: z.boolean().optional(),
  autoFollowUp: z.boolean().optional(),
  commentReplyEnabled: z.boolean().optional(),
  maxRepliesPerUserPerHour: z.number().int().min(1).max(200).optional(),
  allowedTools: z.array(z.string()).optional(),
  defaultLeadFlowId: z.string().nullable().optional(),
  // availability + safety — enforced by src/lib/agent/guardrails.ts
  workingHours: z
    .object({
      timezone: z.string().min(1).max(64),
      days: z.array(z.number().int().min(0).max(6)).min(1).max(7),
      start: z.string().regex(HHMM),
      end: z.string().regex(HHMM),
    })
    .nullable()
    .optional(),
  outsideHoursReply: z.string().max(900).nullable().optional(),
  fallbackReply: z.string().max(900).nullable().optional(),
  allowedTopics: z.string().max(2000).nullable().optional(),
  prohibitedTopics: z.string().max(2000).nullable().optional(),
  responseLength: z.enum(["SHORT", "MEDIUM", "LONG"]).optional(),
  ctaText: z.string().max(500).nullable().optional(),
  faq: z.string().max(20000).nullable().optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, updateSchema);

  const existing = await prisma.aIAgent.findUnique({ where: { id } });
  if (!existing) throw notFound("Agent");
  await assertAccountAccess(auth, existing.accountId);

  if (body.allowedTools) {
    const invalid = body.allowedTools.filter((t) => !TOOLS_BY_ID.has(t));
    if (invalid.length > 0) throw validationError(`Unknown tools: ${invalid.join(", ")}`);
  }
  if (body.defaultLeadFlowId) {
    const flow = await prisma.leadFlow.findFirst({
      where: { id: body.defaultLeadFlowId, accountId: existing.accountId },
    });
    if (!flow) throw validationError("Lead flow does not belong to this agent's Instagram account");
  }

  const { workingHours, ...rest } = body;
  const agent = await prisma.aIAgent.update({
    where: { id },
    data: {
      ...rest,
      ...(workingHours !== undefined ? { workingHours: workingHours === null ? Prisma.JsonNull : workingHours } : {}),
    },
  });

  const promptChanged = body.systemPrompt !== undefined && body.systemPrompt !== existing.systemPrompt;
  await audit({
    adminId: auth.admin.id,
    action: promptChanged ? AuditActions.CHANGED_AGENT_PROMPT : AuditActions.UPDATED_AGENT,
    resourceType: "ai_agent",
    resourceId: id,
    before: promptChanged
      ? { systemPrompt: existing.systemPrompt.slice(0, 500) }
      : { enabled: existing.enabled, autoReply: existing.autoReply },
    after: promptChanged
      ? { systemPrompt: agent.systemPrompt.slice(0, 500) }
      : { ...sanitizeToggles(body) },
    ip: clientIp(req),
  });
  return ok({ agent });
});

function sanitizeToggles(body: Record<string, unknown>) {
  const keys = [
    "enabled",
    "autoReply",
    "leadQualification",
    "knowledgeEnabled",
    "humanHandoffEnabled",
    "autoFollowUp",
    "commentReplyEnabled",
    "provider",
    "model",
    "allowedTools",
    "responseLength",
    "workingHours",
  ];
  return Object.fromEntries(Object.entries(body).filter(([k]) => keys.includes(k)));
}

export const DELETE = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const existing = await prisma.aIAgent.findUnique({ where: { id } });
  if (!existing) throw notFound("Agent");
  await assertAccountAccess(auth, existing.accountId);
  await prisma.aIAgent.delete({ where: { id } });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.DELETED_AGENT,
    resourceType: "ai_agent",
    resourceId: id,
    before: { name: existing.name },
    ip: clientIp(req),
  });
  return ok({ deleted: true });
});
