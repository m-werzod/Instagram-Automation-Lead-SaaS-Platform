import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { AppError, notFound } from "@/lib/errors";
import { safeQuestionSchema } from "@/lib/validation/leadbutton";
import { ACTIVE_QUESTION_FILTER, syncFlowQuestions } from "@/lib/leadflow/engine";

export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const flow = await prisma.leadFlow.findUnique({
    where: { id },
    include: {
      questions: { where: ACTIVE_QUESTION_FILTER, orderBy: { order: "asc" } },
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
  questions: z.array(safeQuestionSchema).min(1).max(25).optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, updateSchema);

  const existing = await prisma.leadFlow.findUnique({
    where: { id },
    include: { questions: { where: ACTIVE_QUESTION_FILTER } },
  });
  if (!existing) throw notFound("Lead flow");
  await assertAccountAccess(auth, existing.accountId);

  const flow = await prisma.$transaction(async (tx) => {
    if (body.questions) {
      const { changed } = await syncFlowQuestions(tx, id, body.questions);
      // A changed question list invalidates in-flight sessions (their pointer
      // could reference a question that is gone) — cancel them explicitly.
      if (changed) {
        await tx.leadFlowSession.updateMany({ where: { flowId: id, status: "ACTIVE" }, data: { status: "CANCELLED" } });
      }
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
      include: { questions: { where: ACTIVE_QUESTION_FILTER, orderBy: { order: "asc" } } },
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

  // CtaConfig.leadFlowId is a plain column with no FK, so a deleted flow leaves
  // a dangling reference that breaks the Lead Button builder and its landing
  // page. Refuse instead — the admin decides which of the two to give up.
  const usedBy = await prisma.ctaConfig.findMany({
    where: { leadFlowId: id },
    select: { id: true, name: true, landingSlug: true },
  });
  if (usedBy.length > 0) {
    const names = usedBy.map((c) => c.name).join(", ");
    throw new AppError("CONFLICT", "This question flow is still in use", {
      reason: `It powers ${usedBy.length === 1 ? "the button" : "the buttons"} ${names}${usedBy[0]!.landingSlug ? ` (page /f/${usedBy[0]!.landingSlug})` : ""}, which would stop working.`,
      fix: "Point that button at another flow — or delete the button — and then delete this flow.",
      details: { ctaConfigIds: usedBy.map((c) => c.id) },
    });
  }

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
