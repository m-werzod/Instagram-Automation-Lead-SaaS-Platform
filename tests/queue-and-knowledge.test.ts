import { describe, expect, it } from "vitest";
import { backoffMs } from "@/lib/queue";
import { bufferToEmbedding, chunkText, cosineSimilarity, embeddingToBuffer, keywordScore } from "@/lib/knowledge";
import { parseAnalysisJson } from "@/lib/content/analysis";

describe("queue backoff", () => {
  it("grows exponentially and caps at 2h", () => {
    const a1 = backoffMs(1);
    const a2 = backoffMs(2);
    const a3 = backoffMs(3);
    expect(a1).toBeGreaterThanOrEqual(30_000);
    expect(a1).toBeLessThan(40_000);
    expect(a2).toBeGreaterThanOrEqual(120_000);
    expect(a3).toBeGreaterThanOrEqual(480_000);
    expect(backoffMs(10)).toBeLessThanOrEqual(2 * 3600_000 + 5_000);
  });
});

describe("knowledge chunking", () => {
  it("returns single chunk for short text", () => {
    expect(chunkText("Hello world")).toEqual(["Hello world"]);
  });

  it("splits long text on paragraphs within budget", () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} ${"content ".repeat(30)}`);
    const chunks = chunkText(paragraphs.join("\n\n"), { maxChars: 800, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(800 + 100);
  });

  it("hard-splits a single huge paragraph", () => {
    const huge = "x".repeat(5000);
    const chunks = chunkText(huge, { maxChars: 1000, overlapChars: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(5);
  });

  it("returns empty for whitespace", () => {
    expect(chunkText("   \n\n  ")).toEqual([]);
  });
});

describe("embedding storage round-trip + similarity", () => {
  it("round-trips float vectors through bytes", () => {
    const vec = [0.1, -0.5, 0.9, 42];
    const restored = bufferToEmbedding(embeddingToBuffer(vec));
    expect([...restored].map((v) => Math.round(v * 1000) / 1000)).toEqual([0.1, -0.5, 0.9, 42]);
  });

  it("cosine similarity behaves", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0, 0]);
    const c = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0);
    expect(cosineSimilarity(a, new Float32Array([0, 0, 0]))).toBe(0);
  });
});

describe("keyword retrieval fallback", () => {
  it("scores documents containing query terms higher", () => {
    const query = "course price Namangan";
    const relevant = "The driving course price in Namangan is 1,200,000 UZS for the B category course.";
    const irrelevant = "Our instructors have 10 years of experience and love teaching.";
    expect(keywordScore(query, relevant)).toBeGreaterThan(keywordScore(query, irrelevant));
  });

  it("ignores stopwords-only queries", () => {
    expect(keywordScore("the and of", "anything")).toBe(0);
  });
});

describe("content analysis JSON parsing", () => {
  it("parses valid model output and clamps enums", () => {
    const out = parseAnalysisJson(
      `Here you go:\n{"topic":"Driving course promo","audience":"18-35 Namangan","salesIntent":"HIGH - direct offer","leadPotential":"high","recommendedCta":"SIGN_UP","recommendedObjective":"OUTCOME_LEADS","recommendedCopy":"Join now","captionQuality":"good","reasoning":"Direct paid course promotion."}`,
    );
    expect(out.leadPotential).toBe("HIGH");
    expect(out.recommendedCta).toBe("SIGN_UP");
  });

  it("falls back to safe values for invalid enums", () => {
    const out = parseAnalysisJson(
      `{"topic":"t","audience":"a","salesIntent":"LOW","leadPotential":"banana","recommendedCta":"NOT_A_CTA","recommendedObjective":"NOPE","recommendedCopy":"c","captionQuality":"q","reasoning":"r"}`,
    );
    expect(out.leadPotential).toBe("MEDIUM");
    expect(out.recommendedCta).toBe("LEARN_MORE");
    expect(out.recommendedObjective).toBe("OUTCOME_TRAFFIC");
  });

  it("throws a typed error on non-JSON output", () => {
    expect(() => parseAnalysisJson("I cannot analyze this")).toThrow(/unparseable|JSON/i);
  });
});
