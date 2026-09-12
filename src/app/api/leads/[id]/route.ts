import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess, grantedAccountIds } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { runAutomations } from "@/lib/automation/engine";

export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      account: { select: { id: true, username: true } },
      campaign: { select: { id: true, name: true } },
      flow: { select: { id: true, name: true } },
      content: { select: { id: true, caption: true, permalink: true } },
      assignedAdmin: { select: { id: true, name: true, login: true } },
      events: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!lead) throw notFound("Lead");
  await assertAccountAccess(auth, lead.accountId);
  const emails = await prisma.emailEvent.findMany({ where: { leadId: id }, orderBy: { createdAt: "desc" }, take: 10 });
  return ok({ lead, emails });
});

const updateSchema = z.object({
  status: z.enum(["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"]).optional(),
  name: z.string().max(200).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
  assignedAdminId: z.string().nullable().optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, updateSchema);

  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) throw notFound("Lead");
  await assertAccountAccess(auth, existing.accountId);

  if (body.assignedAdminId) {
    const assignee = await prisma.admin.findUnique({ where: { id: body.assignedAdminId }, select: { id: true, isActive: true, role: true } });
    if (!assignee || !assignee.isActive) throw notFound("Assignee");
    if (assignee.role === "USER") {
      const ids = await grantedAccountIds(assignee.id);
      if (!ids.includes(existing.accountId)) {
        throw validationError("This user does not have access to this Instagram account — grant it in Settings → Users first");
      }
    }
  }

  const lead = await prisma.lead.update({ where: { id }, data: body });

  if (body.status && body.status !== existing.status) {
    await prisma.leadEvent.create({
      data: { leadId: id, type: "STATUS_CHANGED", adminId: auth.admin.id, data: { from: existing.status, to: body.status } },
    });
    await runAutomations("LEAD_STATUS_CHANGED", {
      accountId: lead.accountId,
      leadId: lead.id,
      leadStatus: lead.status,
      conversationId: lead.conversationId ?? undefined,
      source: lead.source,
    });
  }
  if (body.notes !== undefined && body.notes !== existing.notes) {
    await prisma.leadEvent.create({ data: { leadId: id, type: "NOTE_ADDED", adminId: auth.admin.id } });
  }
  if (body.assignedAdminId !== undefined && body.assignedAdminId !== existing.assignedAdminId) {
    await prisma.leadEvent.create({
      data: { leadId: id, type: "ASSIGNED", adminId: auth.admin.id, data: { assignedAdminId: body.assignedAdminId } },
    });
  }

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPDATED_LEAD,
    resourceType: "lead",
    resourceId: id,
    before: { status: existing.status },
    after: { status: lead.status },
    ip: clientIp(req),
  });
  return ok({ lead });
});
