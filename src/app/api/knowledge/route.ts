import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { extractText, processDocument } from "@/lib/knowledge";
import { embeddingConfig } from "@/lib/env";

export const GET = route(async (req: NextRequest) => {
  await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId") ?? undefined;
  const documents = await prisma.knowledgeDocument.findMany({
    where: accountId ? { accountId } : {},
    include: { account: { select: { username: true } }, agent: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return ok({
    documents,
    retrievalMode: embeddingConfig() ? "semantic (embeddings)" : "keyword (no EMBEDDING_PROVIDER configured)",
  });
});

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const ALLOWED_EXT = [".pdf", ".docx", ".txt", ".md", ".markdown"];

/** Multipart upload: file + accountId (+ optional agentId, title). */
export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();

  const form = await req.formData().catch(() => null);
  if (!form) throw validationError("Expected multipart/form-data with a file");
  const file = form.get("file");
  const accountId = String(form.get("accountId") ?? "");
  const agentId = form.get("agentId") ? String(form.get("agentId")) : null;
  const title = form.get("title") ? String(form.get("title")).slice(0, 200) : null;

  if (!(file instanceof File)) throw validationError("Missing file");
  if (!accountId) throw validationError("Missing accountId");
  if (file.size > MAX_UPLOAD_BYTES) throw validationError("File too large (max 15 MB)");
  const lower = file.name.toLowerCase();
  if (!ALLOWED_EXT.some((e) => lower.endsWith(e))) {
    throw validationError(`Unsupported file type. Allowed: ${ALLOWED_EXT.join(", ")}`);
  }

  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId } });
  if (!account) throw notFound("Instagram account");
  if (agentId) {
    const agent = await prisma.aIAgent.findFirst({ where: { id: agentId, accountId } });
    if (!agent) throw validationError("Agent does not belong to this account");
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const doc = await prisma.knowledgeDocument.create({
    data: {
      accountId,
      agentId,
      title: title || file.name,
      filename: file.name,
      mimeType: file.type || null,
      sizeBytes: file.size,
      status: "PENDING",
    },
  });

  // Extraction + chunking + embedding runs inline (files are small) but the
  // document row exists first so failures are visible with a status + error.
  try {
    const text = await extractText(buffer, file.type ?? "", file.name);
    await processDocument(doc.id, text);
  } catch {
    // status/error already persisted by processDocument or extract failure below
    const fresh = await prisma.knowledgeDocument.findUnique({ where: { id: doc.id } });
    if (fresh && fresh.status === "PENDING") {
      await prisma.knowledgeDocument.update({
        where: { id: doc.id },
        data: { status: "ERROR", error: "Text extraction failed for this file" },
      });
    }
  }

  const final = await prisma.knowledgeDocument.findUniqueOrThrow({ where: { id: doc.id } });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPLOADED_KNOWLEDGE,
    resourceType: "knowledge_document",
    resourceId: doc.id,
    after: { title: final.title, status: final.status, chunks: final.chunkCount },
    ip: clientIp(req),
  });
  return ok({ document: final });
});
