import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { questionSchema } from "@/lib/validation/leadflow";

export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const flow = await prisma.leadFlow.findUnique({
    where: { id },
    include: {
      questions: { orderBy: { order: "asc" } },
      account: { select: { id: true, username: true } },
      _count: { select: { sessions: true, leads: true } },
    },
  });
  if (!flow) throw notFound("Lead flow");
  await assertAccountAccess(auth, flow.accountId);
  return ok({ flow });
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
  triggerKeywords: z.array(z.string().min(1).max(60)).max(20).optional(),
  completionMessage: z.string().max(900).nullable().optional(),
  /** full replacement of the question list (order = array order) */
  questions: z.array(questionSchema).min(1).max(25).optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, updateSchema);

  const existing = await prisma.leadFlow.findUnique({ where: { id }, include: { questions: true } });
  if (!existing) throw notFound("Lead flow");
  await assertAccountAccess(auth, existing.accountId);

  const flow = await prisma.$transaction(async (tx) => {
    if (body.questions) {
      // Replacing questions invalidates in-flight sessions (their pointer
      // could reference a deleted question) — cancel them explicitly.
      await tx.leadFlowSession.updateMany({ where: { flowId: id, status: "ACTIVE" }, data: { status: "CANCELLED" } });
      await tx.leadFlowQuestion.deleteMany({ where: { flowId: id } });
      await tx.leadFlowQuestion.createMany({
        data: body.questions.map((q, i) => ({
          flowId: id,
          order: i + 1,
          title: q.title,
          prompt: q.prompt,
          type: q.type,
          required: q.required,
          options: q.options,
          mapTo: q.mapTo ?? null,
          validationRegex: q.validationRegex ?? null,
        })),
      });
    }
    return tx.leadFlow.update({
      where: { id },
      data: {
        name: body.name,
        description: body.description,
        enabled: body.enabled,
        triggerKeywords: body.triggerKeywords,
        completionMessage: body.completionMessage,
      },
      include: { questions: { orderBy: { order: "asc" } } },
    });
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CHANGED_LEAD_FLOW,
    resourceType: "lead_flow",
    resourceId: id,
    before: { questions: existing.questions.length, enabled: existing.enabled },
    after: { questions: flow.questions.length, enabled: flow.enabled },
    ip: clientIp(req),
  });
  return ok({ flow });
});

export const DELETE = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const existing = await prisma.leadFlow.findUnique({ where: { id } });
  if (!existing) throw notFound("Lead flow");
  await assertAccountAccess(auth, existing.accountId);
  await prisma.leadFlow.delete({ where: { id } });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.DELETED_LEAD_FLOW,
    resourceType: "lead_flow",
    resourceId: id,
    before: { name: existing.name },
    ip: clientIp(req),
  });
  return ok({ deleted: true });
});
