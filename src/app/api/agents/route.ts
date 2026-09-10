import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { DEFAULT_ALLOWED_TOOLS, AGENT_TOOLS } from "@/lib/agent/tools";
import { DEFAULT_MODELS } from "@/lib/ai";
import { isProviderConfigured } from "@/lib/ai";

export const GET = route(async (req: NextRequest) => {
  await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId") ?? undefined;
  const agents = await prisma.aIAgent.findMany({
    where: accountId ? { accountId } : {},
    include: { account: { select: { username: true, isDemo: true } }, _count: { select: { conversations: true } } },
    orderBy: { createdAt: "asc" },
  });
  return ok({
    agents: agents.map((a) => ({ ...a, providerConfigured: isProviderConfigured(a.provider) })),
    availableTools: AGENT_TOOLS.map((t) => ({ id: t.id, risk: t.risk, description: t.def.description })),
  });
});

const createSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  provider: z.enum(["ANTHROPIC", "OPENAI", "GOOGLE"]).default("ANTHROPIC"),
  model: z.string().max(100).optional(),
  systemPrompt: z.string().min(10).max(20000),
  language: z.string().max(60).optional(),
  tone: z.string().max(200).optional(),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, createSchema);

  const account = await prisma.instagramAccount.findUnique({ where: { id: body.accountId } });
  if (!account) throw notFound("Instagram account");

  const providerName = { ANTHROPIC: "anthropic", OPENAI: "openai", GOOGLE: "google" } as const;
  const agent = await prisma.aIAgent.create({
    data: {
      accountId: body.accountId,
      name: body.name,
      description: body.description,
      provider: body.provider,
      model: body.model?.trim() || DEFAULT_MODELS[providerName[body.provider]],
      systemPrompt: body.systemPrompt,
      language: body.language,
      tone: body.tone,
      allowedTools: DEFAULT_ALLOWED_TOOLS,
      enabled: false, // agents start OFF — admin flips the switch deliberately
    },
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CREATED_AGENT,
    resourceType: "ai_agent",
    resourceId: agent.id,
    after: { name: agent.name, accountId: agent.accountId },
    ip: clientIp(req),
  });
  return ok({ agent });
});
