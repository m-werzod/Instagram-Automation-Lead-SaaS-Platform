import { aiTimeoutMs } from "@/lib/env";

/**
 * Provider-agnostic chat + tool-calling contract (spec §9).
 * Implementations: anthropic.ts, openai.ts, google.ts — REST only, keys are
 * server-side, requests/responses are mapped to this shape and unit-tested.
 */

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema object for the arguments */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text?: string | null; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; result: string };

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatTurn[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Wall-clock moment (epoch ms) this call must be finished by, retry included.
   * The caller owns the budget — an agent turn has to leave room for the send
   * before the platform kills the invocation — so the provider passes it down
   * instead of starting a fresh full-length attempt of its own.
   */
  deadlineMs?: number;
}

export interface ChatResponse {
  text: string | null;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
  /** Exact cost when the provider reports it (gateways do); otherwise estimated downstream. */
  costUsd?: number | null;
}

export interface AIProvider {
  readonly name: "anthropic" | "openai" | "google";
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface EmbeddingProvider {
  /** `deadlineMs` bounds the call the same way ChatRequest.deadlineMs bounds a chat. */
  embed(texts: string[], opts?: { deadlineMs?: number }): Promise<number[][]>;
  readonly dimension: number;
  readonly model: string;
}

export class AIProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  /** Safe to retry later (rate limit, 5xx, network, timeout) vs. a permanent refusal (bad key, bad model). */
  readonly retryable: boolean;
  /** Seconds the provider asked us to wait, when it said. */
  readonly retryAfterSec?: number;
  constructor(provider: string, message: string, status?: number, opts: { retryAfterSec?: number; retryable?: boolean } = {}) {
    super(`[${provider}] ${message}`);
    this.name = "AIProviderError";
    this.provider = provider;
    this.status = status;
    // No status = the request never reached the provider (socket, DNS, TLS,
    // abort). That is transient by nature, so it stays retryable — anything
    // else would hand the customer a canned fallback over a dropped packet.
    this.retryable = opts.retryable ?? (status === undefined || status === 429 || status === 408 || status >= 500);
    this.retryAfterSec = opts.retryAfterSec;
  }

  /** What an admin should read — the provider's own words, without the SDK noise. */
  get userMessage(): string {
    if (this.status === 401 || this.status === 403) return "The AI provider rejected the API key.";
    if (this.status === 402) return "The AI provider requires a paid plan or balance for this model — pick a model your plan includes.";
    if (this.status === 404) return "The AI provider does not know this model name.";
    if (this.status === 429) return `The AI provider is rate-limiting requests${this.retryAfterSec ? ` — try again in ${this.retryAfterSec}s` : ""}.`;
    if (this.status === 408) return "The AI provider did not answer in time.";
    if (this.status !== undefined && this.status >= 500) return "The AI provider is having a problem on its side.";
    return this.message.replace(/^\[[^\]]+\]\s*/, "");
  }
}

/** Errors worth one immediate retry: transient network trouble and 5xx. Never 4xx (that includes 429 — the queue backs off instead). */
function transient(status: number | undefined): boolean {
  return status === undefined || status >= 500;
}

/** Below this there is no point starting another attempt — it could only be killed half-way. */
const MIN_ATTEMPT_MS = 2_000;

function remainingMs(deadlineMs: number | undefined): number {
  return deadlineMs === undefined ? Number.POSITIVE_INFINITY : deadlineMs - Date.now();
}

/**
 * One HTTP call to an AI provider with a hard timeout and a single retry for
 * transient failures. Every provider goes through here so timeouts, retries
 * and error shaping live in one place.
 *
 * `deadlineMs` caps the WHOLE call: each attempt is shortened to what is left
 * and the retry is skipped when the backoff plus a usable attempt no longer
 * fit. Without it, one retry could double a 60s timeout and outlive the
 * serverless invocation that is waiting for the answer.
 */
export async function aiFetch(
  provider: string,
  url: string,
  init: RequestInit,
  opts: { timeoutMs?: number; retries?: number; deadlineMs?: number } = {},
): Promise<Record<string, unknown>> {
  const hardTimeoutMs = opts.timeoutMs ?? aiTimeoutMs();
  const retries = opts.retries ?? 1;
  const deadlineMs = opts.deadlineMs;
  /** Retry only while the backoff AND a usable attempt still fit in the budget. */
  const mayRetry = (attempt: number, backoff: number) =>
    attempt <= retries && remainingMs(deadlineMs) > backoff + MIN_ATTEMPT_MS;

  let attempt = 0;
  while (true) {
    attempt++;
    const left = remainingMs(deadlineMs);
    if (left < MIN_ATTEMPT_MS) {
      throw new AIProviderError(provider, "the time budget for this turn ran out before the provider answered", undefined, {
        retryable: true,
      });
    }
    const timeoutMs = Math.min(hardTimeoutMs, left);
    const backoffMs = 1500 * attempt;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err instanceof Error && err.name === "AbortError";
      if (mayRetry(attempt, backoffMs)) {
        await sleep(backoffMs);
        continue;
      }
      if (aborted) throw new AIProviderError(provider, `timed out after ${Math.round(timeoutMs / 1000)}s`, 408);
      throw new AIProviderError(provider, `network error: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(timer);

    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      if (!res.ok) {
        if (transient(res.status) && mayRetry(attempt, backoffMs)) {
          await sleep(backoffMs);
          continue;
        }
        throw new AIProviderError(provider, `HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
      }
      throw new AIProviderError(provider, `non-JSON response: ${text.slice(0, 300)}`, undefined, { retryable: false });
    }
    if (!res.ok) {
      if (transient(res.status) && mayRetry(attempt, backoffMs)) {
        await sleep(backoffMs);
        continue;
      }
      const msg =
        (json.error as { message?: string } | undefined)?.message ??
        (typeof json.error === "string" ? json.error : `HTTP ${res.status}`);
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new AIProviderError(provider, msg, res.status, {
        retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : undefined,
      });
    }
    return json;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default model per provider — overridable per agent in the UI and by AI_MODEL for the default provider. */
export const DEFAULT_MODELS: Record<"anthropic" | "openai" | "google", string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-2.5-flash",
};
