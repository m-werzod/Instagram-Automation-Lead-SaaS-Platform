import { NextRequest, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope, assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { enqueueDocumentProcessing, extractText, markDocumentFailed, storeDocumentChunks } from "@/lib/knowledge";
import { getEmbeddingProvider } from "@/lib/ai";
import { drainNow } from "@/lib/queue";

/**
 * What retrieval will actually do for these documents — never a guess. A
 * document embedded with another model cannot be ranked against the current
 * one, so retrieval drops to keyword until it is re-processed; the admin has
 * to be told that, not left with a "semantic" badge that is not true.
 */
function describeRetrieval(documents: Array<{ status: string; embeddingProvider: string | null }>): string {
  const embedder = getEmbeddingProvider();
  if (!embedder) return "keyword (no EMBEDDING_PROVIDER configured)";
  const stale = documents.filter((d) => d.status === "READY" && d.embeddingProvider !== embedder.model).length;
  if (stale > 0) {
    return `keyword — ${stale} document(s) are not embedded with ${embedder.model}; re-process them for semantic search`;
  }
  return `semantic (embeddings: ${embedder.model})`;
}

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId") ?? undefined;
  const documents = await prisma.knowledgeDocument.findMany({
    where: await accountScope(auth, accountId),
    include: { account: { select: { username: true } }, agent: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return ok({ documents, retrievalMode: describeRetrieval(documents) });
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
  await assertAccountAccess(auth, account.id);
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

  // Extraction + chunking stay here (local CPU, bounded by the upload cap) so
  // the document's own text is stored and can be re-processed later. Embedding
  // is N provider round-trips with no predictable duration — it runs as a job,
  // which is what keeps a large document from dying half-way through a request
  // and sitting in PROCESSING forever.
  try {
    const text = await extractText(buffer, file.type ?? "", file.name);
    await storeDocumentChunks(doc.id, text);
    await enqueueDocumentProcessing(doc.id);
    after(() => drainNow());
  } catch (err) {
    await markDocumentFailed(doc.id, err);
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
