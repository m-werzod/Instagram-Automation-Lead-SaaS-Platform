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
}

export interface ChatResponse {
  text: string | null;
  toolCalls: ToolCall[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

export interface AIProvider {
  readonly name: "anthropic" | "openai" | "google";
  chat(req: ChatRequest): Promise<ChatResponse>;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
  readonly model: string;
}

export class AIProviderError extends Error {
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(provider: string, message: string, status?: number) {
    super(`[${provider}] ${message}`);
    this.name = "AIProviderError";
    this.provider = provider;
    this.status = status;
    this.retryable = status === 429 || (status !== undefined && status >= 500);
  }
}

export async function aiFetch(provider: string, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new AIProviderError(provider, `network error: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    if (!res.ok) throw new AIProviderError(provider, `HTTP ${res.status}: ${text.slice(0, 300)}`, res.status);
    throw new AIProviderError(provider, `non-JSON response: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    const msg =
      (json.error as { message?: string } | undefined)?.message ??
      (typeof json.error === "string" ? json.error : `HTTP ${res.status}`);
    throw new AIProviderError(provider, msg, res.status);
  }
  return json;
}

/** Default model per provider — overridable per agent in the UI. */
export const DEFAULT_MODELS: Record<"anthropic" | "openai" | "google", string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-4o-mini",
  google: "gemini-2.5-flash",
};
