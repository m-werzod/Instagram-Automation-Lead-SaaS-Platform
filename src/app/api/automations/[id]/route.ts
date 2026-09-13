import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { conditionSchema, actionSchema } from "@/lib/validation/automation";
import type { Prisma } from "@prisma/client";

export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const automation = await prisma.automation.findUnique({
    where: { id },
    include: { runs: { orderBy: { createdAt: "desc" }, take: 30 } },
  });
  if (!automation) throw notFound("Automation");
  await assertAccountAccess(auth, automation.accountId);
  return ok({ automation });
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  /** Scopes a COMMENT_RECEIVED rule to one post/reel; null = every post on the account. */
  contentId: z.string().min(1).nullable().optional(),
  conditions: z.array(conditionSchema).max(10).optional(),
  actions: z.array(actionSchema).min(1).max(10).optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, updateSchema);

  const existing = await prisma.automation.findUnique({ where: { id } });
  if (!existing) throw notFound("Automation");
  await assertAccountAccess(auth, existing.accountId);

  if (body.contentId) {
    const content = await prisma.contentItem.findFirst({ where: { id: body.contentId, accountId: existing.accountId } });
    if (!content) throw validationError("Selected post/reel does not belong to this account");
  }
  for (const action of body.actions ?? []) {
    if (action.type !== "SEND_COMMENT_RESOURCE") continue;
    if (action.params.resourceId) {
      const resource = await prisma.commentResource.findFirst({ where: { id: action.params.resourceId, accountId: existing.accountId } });
      if (!resource) throw validationError("Selected resource does not belong to this account");
    }
    if (action.params.agentId) {
      const agent = await prisma.aIAgent.findFirst({ where: { id: action.params.agentId, accountId: existing.accountId } });
      if (!agent) throw validationError("Selected agent does not belong to this account");
    }
  }

  const automation = await prisma.automation.update({
    where: { id },
    data: {
      name: body.name,
      description: body.description,
      enabled: body.enabled,
      contentId: body.contentId !== undefined ? body.contentId : undefined,
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
  await assertAccountAccess(auth, existing.accountId);
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
