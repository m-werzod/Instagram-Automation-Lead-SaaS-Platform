import { NextRequest, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { enqueueDocumentProcessing } from "@/lib/knowledge";
import { drainNow } from "@/lib/queue";

export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const document = await prisma.knowledgeDocument.findUnique({
    where: { id },
    include: { chunks: { orderBy: { idx: "asc" }, take: 5, select: { idx: true, text: true } } },
  });
  if (!document) throw notFound("Document");
  await assertAccountAccess(auth, document.accountId);
  return ok({ document });
});

/**
 * Re-run the embedding pass for one document. This is the way out of two dead
 * ends the admin could otherwise only fix by deleting and re-uploading: a
 * document left in PROCESSING because the worker died mid-embedding, and one
 * embedded with a provider that has since been switched (its vectors can no
 * longer be ranked, so retrieval silently falls back to keyword).
 */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const existing = await prisma.knowledgeDocument.findUnique({
    where: { id },
    include: { _count: { select: { chunks: true } } },
  });
  if (!existing) throw notFound("Document");
  await assertAccountAccess(auth, existing.accountId);
  if (existing._count.chunks === 0) {
    throw validationError("This document has no stored text to re-process — delete it and upload the file again.");
  }

  await prisma.knowledgeDocument.update({ where: { id }, data: { status: "PROCESSING", error: null } });
  await enqueueDocumentProcessing(id);
  after(() => drainNow());

  await audit({
    adminId: auth.admin.id,
    action: "REPROCESSED_KNOWLEDGE",
    resourceType: "knowledge_document",
    resourceId: id,
    before: { status: existing.status, embeddingProvider: existing.embeddingProvider },
    ip: clientIp(req),
  });
  const document = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id } });
  return ok({ document, queued: true });
});

export const DELETE = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const existing = await prisma.knowledgeDocument.findUnique({ where: { id } });
  if (!existing) throw notFound("Document");
  await assertAccountAccess(auth, existing.accountId);
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
