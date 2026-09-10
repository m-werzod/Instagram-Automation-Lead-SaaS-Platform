import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import type { Prisma } from "@prisma/client";

export const GET = route(async (_req, ctx: RouteCtx) => {
  await requireAdmin();
  const id = await pathParam(ctx, "id");
  const automation = await prisma.automation.findUnique({
    where: { id },
    include: { runs: { orderBy: { createdAt: "desc" }, take: 30 } },
  });
  if (!automation) throw notFound("Automation");
  return ok({ automation });
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.string() })).max(10).optional(),
  actions: z.array(z.object({ type: z.string(), params: z.record(z.unknown()) })).min(1).max(10).optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, updateSchema);

  const existing = await prisma.automation.findUnique({ where: { id } });
  if (!existing) throw notFound("Automation");

  const automation = await prisma.automation.update({
    where: { id },
    data: {
      name: body.name,
      description: body.description,
      enabled: body.enabled,
      conditions: body.conditions !== undefined ? (body.conditions as unknown as Prisma.InputJsonValue) : undefined,
      actions: body.actions !== undefined ? (body.actions as unknown as Prisma.InputJsonValue) : undefined,
    },
  });

  const action =
    body.enabled === undefined
      ? AuditActions.UPDATED_AUTOMATION
      : body.enabled
        ? AuditActions.ENABLED_AUTOMATION
        : AuditActions.DISABLED_AUTOMATION;
  await audit({
    adminId: auth.admin.id,
    action,
    resourceType: "automation",
    resourceId: id,
    before: { enabled: existing.enabled },
    after: { enabled: automation.enabled },
    ip: clientIp(req),
  });
  return ok({ automation });
});

export const DELETE = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const existing = await prisma.automation.findUnique({ where: { id } });
  if (!existing) throw notFound("Automation");
  await prisma.automation.delete({ where: { id } });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.DELETED_AUTOMATION,
    resourceType: "automation",
    resourceId: id,
    before: { name: existing.name },
    ip: clientIp(req),
  });
  return ok({ deleted: true });
});
