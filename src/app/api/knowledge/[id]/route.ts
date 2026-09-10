import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";

export const GET = route(async (_req, ctx: RouteCtx) => {
  await requireAdmin();
  const { id } = await ctx.params;
  const document = await prisma.knowledgeDocument.findUnique({
    where: { id },
    include: { chunks: { orderBy: { idx: "asc" }, take: 5, select: { idx: true, text: true } } },
  });
  if (!document) throw notFound("Document");
  return ok({ document });
});

export const DELETE = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;
  const existing = await prisma.knowledgeDocument.findUnique({ where: { id } });
  if (!existing) throw notFound("Document");
  await prisma.knowledgeDocument.delete({ where: { id } });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.DELETED_KNOWLEDGE,
    resourceType: "knowledge_document",
    resourceId: id,
    before: { title: existing.title },
    ip: clientIp(req),
  });
  return ok({ deleted: true });
});
