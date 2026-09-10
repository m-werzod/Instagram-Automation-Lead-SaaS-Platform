import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { runAutomations } from "@/lib/automation/engine";

export const GET = route(async (_req, ctx: RouteCtx) => {
  await requireAdmin();
  const { id } = await ctx.params;
  const lead = await prisma.lead.findUnique({
    where: { id },
    include: {
      account: { select: { id: true, username: true } },
      campaign: { select: { id: true, name: true } },
      flow: { select: { id: true, name: true } },
      content: { select: { id: true, caption: true, permalink: true } },
      events: { orderBy: { createdAt: "desc" }, take: 50 },
    },
  });
  if (!lead) throw notFound("Lead");
  const emails = await prisma.emailEvent.findMany({ where: { leadId: id }, orderBy: { createdAt: "desc" }, take: 10 });
  return ok({ lead, emails });
});

const updateSchema = z.object({
  status: z.enum(["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"]).optional(),
  name: z.string().max(200).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;
  const body = await parseBody(req, updateSchema);

  const existing = await prisma.lead.findUnique({ where: { id } });
  if (!existing) throw notFound("Lead");

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
