import type { AIProviderType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { aiKeyFor, embeddingConfig, type AIProviderName } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { AnthropicProvider } from "./anthropic";
import { GoogleEmbeddings, GoogleProvider } from "./google";
import { OpenAIEmbeddings, OpenAIProvider } from "./openai";
import type { AIProvider, EmbeddingProvider } from "./provider";

export * from "./provider";

const providerNames: Record<AIProviderType, AIProviderName> = {
  ANTHROPIC: "anthropic",
  OPENAI: "openai",
  GOOGLE: "google",
};

export function providerNameOf(type: AIProviderType): AIProviderName {
  return providerNames[type];
}

export function getProvider(type: AIProviderType): AIProvider {
  const name = providerNames[type];
  const key = aiKeyFor(name);
  if (!key) {
    throw new AppError("CONFIG_MISSING", `No API key configured for AI provider "${name}"`, {
      reason: `Neither ${name.toUpperCase()}_API_KEY nor AI_API_KEY (with AI_PROVIDER=${name}) is set.`,
      fix: "Add the key to .env and restart. Keys are server-side only.",
    });
  }
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(key);
    case "openai":
      return new OpenAIProvider(key);
    case "google":
      return new GoogleProvider(key);
  }
}

export function isProviderConfigured(type: AIProviderType): boolean {
  return aiKeyFor(providerNames[type]) !== null;
}

export function getEmbeddingProvider(): EmbeddingProvider | null {
  const cfg = embeddingConfig();
  if (!cfg) return null;
  return cfg.provider === "openai" ? new OpenAIEmbeddings(cfg.apiKey) : new GoogleEmbeddings(cfg.apiKey);
}

// ---- cost estimation (USD per 1M tokens; estimates, surfaced as such) ----

const PRICES: Record<string, { inPerM: number; outPerM: number }> = {
  "claude-sonnet-4-5": { inPerM: 3, outPerM: 15 },
  "claude-haiku-4-5": { inPerM: 1, outPerM: 5 },
  "claude-opus-4-1": { inPerM: 15, outPerM: 75 },
  "gpt-4o": { inPerM: 2.5, outPerM: 10 },
  "gpt-4o-mini": { inPerM: 0.15, outPerM: 0.6 },
  "gemini-2.5-flash": { inPerM: 0.3, outPerM: 2.5 },
  "gemini-2.5-pro": { inPerM: 1.25, outPerM: 10 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  if (!key) return null;
  const p = PRICES[key]!;
  return (inputTokens * p.inPerM + outputTokens * p.outPerM) / 1_000_000;
}

export interface UsageRecord {
  accountId?: string | null;
  agentId?: string | null;
  provider: string;
  model: string;
  purpose: "reply" | "content_analysis" | "embedding" | "campaign_draft";
  inputTokens: number;
  outputTokens: number;
  latencyMs?: number;
  success: boolean;
  error?: string;
}

export async function recordUsage(u: UsageRecord): Promise<void> {
  await prisma.aIUsage
    .create({
      data: {
        accountId: u.accountId ?? null,
        agentId: u.agentId ?? null,
        provider: u.provider,
        model: u.model,
        purpose: u.purpose,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        costUsd: estimateCostUsd(u.model, u.inputTokens, u.outputTokens),
        latencyMs: u.latencyMs,
        success: u.success,
        error: u.error?.slice(0, 500),
      },
    })
    .catch(() => undefined); // usage accounting must never break the reply path
}
