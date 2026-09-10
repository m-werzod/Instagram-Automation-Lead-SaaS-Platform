import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import type { Prisma } from "@prisma/client";

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  ctaType: z.string().max(40).nullable().optional(),
  url: z.string().url().nullable().optional(),
  leadFlowId: z.string().nullable().optional(),
  overlaySpec: z
    .object({
      text: z.string().min(1).max(60),
      position: z.enum(["bottom", "top", "center"]),
      bgColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    })
    .nullable()
    .optional(),
  messagingKeyword: z.string().max(60).nullable().optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, updateSchema);
  const existing = await prisma.ctaConfig.findUnique({ where: { id } });
  if (!existing) throw notFound("CTA config");

  const cta = await prisma.ctaConfig.update({
    where: { id },
    data: {
      ...body,
      messagingKeyword: body.messagingKeyword !== undefined ? (body.messagingKeyword?.toLowerCase() ?? null) : undefined,
      overlaySpec: body.overlaySpec !== undefined ? ((body.overlaySpec ?? undefined) as Prisma.InputJsonValue | undefined) : undefined,
    },
  });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPDATED_CTA,
    resourceType: "cta_config",
    resourceId: id,
    before: { enabled: existing.enabled },
    after: { enabled: cta.enabled },
    ip: clientIp(req),
  });
  return ok({ cta });
});

export const DELETE = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const existing = await prisma.ctaConfig.findUnique({ where: { id } });
  if (!existing) throw notFound("CTA config");
  await prisma.ctaConfig.delete({ where: { id } });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.DELETED_CTA,
    resourceType: "cta_config",
    resourceId: id,
    before: { name: existing.name, kind: existing.kind },
    ip: clientIp(req),
  });
  return ok({ deleted: true });
});
