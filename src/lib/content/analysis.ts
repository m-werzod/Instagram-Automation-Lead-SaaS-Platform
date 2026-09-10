import { prisma } from "@/lib/prisma";
import { getProvider, recordUsage, DEFAULT_MODELS } from "@/lib/ai";
import { defaultAiProvider } from "@/lib/env";
import { AppError, notFound } from "@/lib/errors";
import { SUPPORTED_CTA_TYPES, SUPPORTED_OBJECTIVES } from "@/lib/meta/marketing";

/**
 * AI content analysis (spec §14). Honest scope: the model sees the caption,
 * media type, and engagement metrics — NOT the video frames. The UI states
 * this. Recommendations never auto-create or launch campaigns.
 */

export interface AnalysisOutput {
  topic: string;
  audience: string;
  salesIntent: string;
  leadPotential: "LOW" | "MEDIUM" | "HIGH";
  recommendedCta: string;
  recommendedObjective: string;
  recommendedCopy: string;
  captionQuality: string;
  reasoning: string;
}

const providerTypeMap = { anthropic: "ANTHROPIC", openai: "OPENAI", google: "GOOGLE" } as const;

export async function analyzeContent(contentId: string): Promise<AnalysisOutput> {
  const content = await prisma.contentItem.findUnique({
    where: { id: contentId },
    include: { account: { select: { username: true } } },
  });
  if (!content) throw notFound("Content item");

  const providerName = defaultAiProvider();
  const providerType = providerTypeMap[providerName];
  const model = DEFAULT_MODELS[providerName];
  const provider = getProvider(providerType);

  const ctaValues = SUPPORTED_CTA_TYPES.map((c) => c.value).join(" | ");
  const objectiveValues = SUPPORTED_OBJECTIVES.map((o) => o.value).join(" | ");

  const prompt = `Analyze this Instagram ${content.mediaProductType === "REELS" ? "Reel" : "post"} from @${content.account.username} for lead-generation potential.

AVAILABLE DATA (you cannot see the video itself — analysis is based on caption + metadata only):
- Caption: ${content.caption ? JSON.stringify(content.caption.slice(0, 1500)) : "(no caption)"}
- Media type: ${content.mediaType} / ${content.mediaProductType ?? "FEED"}
- Likes: ${content.likeCount ?? "unknown"}, Comments: ${content.commentsCount ?? "unknown"}
- Published: ${content.timestamp?.toISOString() ?? "unknown"}

Respond with ONLY a JSON object (no markdown fences) with exactly these keys:
{
  "topic": "one line",
  "audience": "target audience description with age range and location hints if inferable",
  "salesIntent": "LOW|MEDIUM|HIGH with 5-word justification",
  "leadPotential": "LOW" | "MEDIUM" | "HIGH",
  "recommendedCta": one of: ${ctaValues},
  "recommendedObjective": one of: ${objectiveValues},
  "recommendedCopy": "1-2 sentence ad copy suggestion in the caption's language",
  "captionQuality": "one-line assessment",
  "reasoning": "2-3 sentences why"
}`;

  const started = Date.now();
  try {
    const res = await provider.chat({
      model,
      messages: [{ role: "user", text: prompt }],
      temperature: 0.2,
      maxTokens: 800,
    });
    await recordUsage({
      accountId: content.accountId,
      provider: providerName,
      model,
      purpose: "content_analysis",
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      latencyMs: Date.now() - started,
      success: true,
    });

    const parsed = parseAnalysisJson(res.text ?? "");
    await prisma.contentAnalysis.upsert({
      where: { contentId },
      create: { contentId, provider: providerName, model, ...parsed, raw: { text: res.text } },
      update: { provider: providerName, model, ...parsed, raw: { text: res.text }, createdAt: new Date() },
    });
    return parsed;
  } catch (err) {
    await recordUsage({
      accountId: content.accountId,
      provider: providerName,
      model,
      purpose: "content_analysis",
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: Date.now() - started,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function parseAnalysisJson(text: string): AnalysisOutput {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new AppError("AI_PROVIDER_ERROR", "AI returned an unparseable analysis", {
      reason: "The model response contained no JSON object.",
      fix: "Retry the analysis; if it persists, switch the default AI provider/model.",
    });
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    throw new AppError("AI_PROVIDER_ERROR", "AI returned invalid JSON for the analysis");
  }
  const s = (k: string, fallback = "—") => (typeof raw[k] === "string" && (raw[k] as string).trim() ? (raw[k] as string).trim() : fallback);
  const lp = s("leadPotential", "MEDIUM").toUpperCase();
  const validCta = new Set(SUPPORTED_CTA_TYPES.map((c) => c.value as string));
  const validObj = new Set(SUPPORTED_OBJECTIVES.map((o) => o.value as string));
  return {
    topic: s("topic"),
    audience: s("audience"),
    salesIntent: s("salesIntent"),
    leadPotential: lp === "LOW" || lp === "HIGH" ? (lp as "LOW" | "HIGH") : "MEDIUM",
    recommendedCta: validCta.has(s("recommendedCta", "LEARN_MORE")) ? s("recommendedCta") : "LEARN_MORE",
    recommendedObjective: validObj.has(s("recommendedObjective", "OUTCOME_TRAFFIC")) ? s("recommendedObjective") : "OUTCOME_TRAFFIC",
    recommendedCopy: s("recommendedCopy"),
    captionQuality: s("captionQuality"),
    reasoning: s("reasoning"),
  };
}
