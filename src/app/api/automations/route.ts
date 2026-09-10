import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import type { Prisma } from "@prisma/client";

export const GET = route(async (req: NextRequest) => {
  await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId") ?? undefined;
  const automations = await prisma.automation.findMany({
    where: accountId ? { accountId } : {},
    include: { account: { select: { username: true } }, _count: { select: { runs: true } } },
    orderBy: { createdAt: "asc" },
  });
  return ok({ automations });
});

const conditionSchema = z.object({
  field: z.enum(["text", "source", "lead_status", "username"]),
  op: z.enum(["contains", "not_contains", "equals", "starts_with", "regex"]),
  value: z.string().min(1).max(300),
});

const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SEND_MESSAGE"), params: z.object({ text: z.string().min(1).max(900) }) }),
  z.object({ type: z.literal("SEND_PRIVATE_REPLY"), params: z.object({ text: z.string().min(1).max(900) }) }),
  z.object({ type: z.literal("REPLY_COMMENT"), params: z.object({ text: z.string().min(1).max(900) }) }),
  z.object({ type: z.literal("START_LEAD_FLOW"), params: z.object({ flowId: z.string().min(1) }) }),
  z.object({
    type: z.literal("SET_LEAD_STATUS"),
    params: z.object({ status: z.enum(["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"]) }),
  }),
  z.object({ type: z.literal("NOTIFY_ADMIN"), params: z.object({ text: z.string().min(1).max(2000) }) }),
  z.object({ type: z.literal("SET_AI"), params: z.object({ enabled: z.boolean() }) }),
]);

const createSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  trigger: z.enum(["MESSAGE_RECEIVED", "COMMENT_RECEIVED", "LEAD_SUBMITTED", "LEAD_STATUS_CHANGED", "CONVERSATION_HANDOFF"]),
  conditions: z.array(conditionSchema).max(10).default([]),
  actions: z.array(actionSchema).min(1).max(10),
  enabled: z.boolean().default(false),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, createSchema);

  const account = await prisma.instagramAccount.findUnique({ where: { id: body.accountId } });
  if (!account) throw notFound("Instagram account");

  const automation = await prisma.automation.create({
    data: {
      accountId: body.accountId,
      name: body.name,
      description: body.description,
      trigger: body.trigger,
      conditions: body.conditions as unknown as Prisma.InputJsonValue,
      actions: body.actions as unknown as Prisma.InputJsonValue,
      enabled: body.enabled,
    },
  });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CREATED_AUTOMATION,
    resourceType: "automation",
    resourceId: automation.id,
    after: { name: automation.name, trigger: automation.trigger, enabled: automation.enabled },
    ip: clientIp(req),
  });
  return ok({ automation });
});
