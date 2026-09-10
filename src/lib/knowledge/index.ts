import { prisma } from "@/lib/prisma";
import { getEmbeddingProvider } from "@/lib/ai";
import { createLogger, errorFields } from "@/lib/logger";

const log = createLogger("knowledge");

/**
 * Knowledge pipeline: extract → chunk → embed → retrieve (spec §26).
 * Embeddings are stored as Float32Array BYTEA and ranked in-process
 * (deliberate, documented decision — DEVELOPMENT_PLAN.md §3). When no
 * embedding provider is configured, retrieval falls back to keyword scoring
 * and the UI labels the mode.
 */

// ---- extraction ----

export async function extractText(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  const lower = filename.toLowerCase();
  if (mimeType === "application/pdf" || lower.endsWith(".pdf")) {
    // pdf-parse's index.js has a debug harness that breaks under bundlers — import the lib directly.
    const mod = (await import("pdf-parse/lib/pdf-parse.js")) as unknown as {
      default: (b: Buffer) => Promise<{ text: string }>;
    };
    const parsed = await mod.default(buffer);
    return parsed.text;
  }
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lower.endsWith(".docx")
  ) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }
  if (lower.endsWith(".md") || lower.endsWith(".txt") || mimeType.startsWith("text/")) {
    return buffer.toString("utf8");
  }
  throw new Error(`Unsupported file type: ${mimeType || filename}. Supported: PDF, DOCX, TXT, Markdown.`);
}

// ---- chunking ----

export interface ChunkOptions {
  maxChars?: number;
  overlapChars?: number;
}

/** Paragraph-aware sliding window chunker. */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const maxChars = opts.maxChars ?? 1400;
  const overlap = opts.overlapChars ?? 200;
  const clean = text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const push = () => {
    if (current.trim().length > 0) chunks.push(current.trim());
  };

  for (const para of paragraphs) {
    if (para.length > maxChars) {
      // hard-split very long paragraphs with overlap
      push();
      current = "";
      for (let i = 0; i < para.length; i += maxChars - overlap) {
        chunks.push(para.slice(i, i + maxChars));
      }
      continue;
    }
    if (current.length + para.length + 2 > maxChars) {
      push();
      // seed next chunk with tail overlap for context continuity
      current = current.slice(Math.max(0, current.length - overlap)) + "\n\n" + para;
      if (current.length > maxChars) current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  push();
  return chunks;
}

// ---- embedding storage ----

export function embeddingToBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

export function bufferToEmbedding(buf: Buffer | Uint8Array): Float32Array {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---- keyword fallback scoring ----

const STOPWORDS = new Set(
  "a,an,the,and,or,of,to,in,is,are,was,were,for,on,with,as,by,at,be,this,that,it,from,not,what,how,when".split(","),
);

export function keywordScore(query: string, text: string): number {
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  if (terms.length === 0) return 0;
  const hay = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let idx = hay.indexOf(term);
    let hits = 0;
    while (idx !== -1 && hits < 5) {
      hits++;
      idx = hay.indexOf(term, idx + term.length);
    }
    score += hits;
  }
  return score / terms.length;
}

// ---- document processing (called from upload route / worker) ----

export async function processDocument(documentId: string, rawText: string): Promise<void> {
  const doc = await prisma.knowledgeDocument.findUnique({ where: { id: documentId } });
  if (!doc) return;

  await prisma.knowledgeDocument.update({ where: { id: documentId }, data: { status: "PROCESSING" } });
  try {
    const chunks = chunkText(rawText);
    if (chunks.length === 0) throw new Error("No extractable text found in the document");

    const embedder = getEmbeddingProvider();
    let vectors: number[][] | null = null;
    if (embedder) {
      vectors = [];
      const BATCH = 32;
      for (let i = 0; i < chunks.length; i += BATCH) {
        vectors.push(...(await embedder.embed(chunks.slice(i, i + BATCH))));
      }
    }

    await prisma.$transaction([
      prisma.knowledgeChunk.deleteMany({ where: { documentId } }),
      prisma.knowledgeChunk.createMany({
        data: chunks.map((text, idx) => ({
          documentId,
          accountId: doc.accountId,
          idx,
          text,
          embedding: vectors ? embeddingToBuffer(vectors[idx]!) : null,
        })),
      }),
      prisma.knowledgeDocument.update({
        where: { id: documentId },
        data: {
          status: "READY",
          chunkCount: chunks.length,
          embeddingProvider: embedder ? embedder.model : "none",
          error: null,
        },
      }),
    ]);
    log.info("document processed", { documentId, chunks: chunks.length, embedded: Boolean(embedder) });
  } catch (err) {
    await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: "ERROR", error: err instanceof Error ? err.message : String(err) },
    });
    log.error("document processing failed", { documentId, ...errorFields(err) });
    throw err;
  }
}

// ---- retrieval ----

export interface RetrievedChunk {
  text: string;
  score: number;
  documentTitle: string;
}

/**
 * Retrieve top-K chunks for an account (optionally agent-scoped documents
 * first). Semantic when embeddings exist, keyword otherwise.
 */
export async function retrieveKnowledge(
  accountId: string,
  agentId: string | null,
  query: string,
  topK = 5,
): Promise<RetrievedChunk[]> {
  const chunks = await prisma.knowledgeChunk.findMany({
    where: {
      accountId,
      document: {
        status: "READY",
        OR: agentId ? [{ agentId: null }, { agentId }] : [{ agentId: null }, { NOT: { agentId: null } }],
      },
    },
    include: { document: { select: { title: true } } },
    take: 4000, // hard safety cap; small KBs by design
  });
  if (chunks.length === 0) return [];

  const embedder = getEmbeddingProvider();
  const withVectors = chunks.filter((c) => c.embedding && c.embedding.length > 0);

  if (embedder && withVectors.length > 0) {
    try {
      const [queryVec] = await embedder.embed([query]);
      if (queryVec) {
        const q = new Float32Array(queryVec);
        return withVectors
          .map((c) => ({
            text: c.text,
            documentTitle: c.document.title,
            score: cosineSimilarity(q, bufferToEmbedding(c.embedding!)),
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topK)
          .filter((c) => c.score > 0.1);
      }
    } catch (err) {
      log.warn("embedding retrieval failed, falling back to keyword", errorFields(err));
    }
  }

  return chunks
    .map((c) => ({ text: c.text, documentTitle: c.document.title, score: keywordScore(query, c.text) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter((c) => c.score > 0);
}
