import {
  aiFetch,
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatTurn,
  type EmbeddingProvider,
  type ToolCall,
} from "./provider";

export const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * OpenAI Chat Completions mapping. The protocol is shared by many gateways
 * (api.airforce, OpenRouter, local proxies), so the base URL is a parameter —
 * everything else stays identical.
 */
export class OpenAIProvider implements AIProvider {
  readonly name = "openai" as const;
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl: string = OPENAI_DEFAULT_BASE_URL,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private get isOfficial(): boolean {
    return this.baseUrl.includes("api.openai.com");
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages: Array<Record<string, unknown>> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const turn of req.messages) messages.push(...mapTurn(turn));

    const body = {
      model: req.model,
      messages,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      // OpenAI itself deprecated max_tokens for chat; most compatible gateways only know max_tokens.
      ...(req.maxTokens ? (this.isOfficial ? { max_completion_tokens: req.maxTokens } : { max_tokens: req.maxTokens }) : {}),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
    };

    const json = await aiFetch(
      "openai",
      `${this.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
      },
      { deadlineMs: req.deadlineMs },
    );

    const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
    const message = (choice.message ?? {}) as {
      content?: string | null;
      tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
    };
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: tc.function?.name ?? "",
      arguments: safeParse(tc.function?.arguments),
    }));
    const usage = (json.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number; cost?: number };

    return {
      text: message.content ?? null,
      toolCalls,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      stopReason: (choice.finish_reason as string | undefined) ?? null,
      // Gateways report the real charge; the official API does not.
      costUsd: typeof usage.cost === "number" ? usage.cost : null,
    };
  }
}

function mapTurn(turn: ChatTurn): Array<Record<string, unknown>> {
  if (turn.role === "user") return [{ role: "user", content: turn.text }];
  if (turn.role === "assistant") {
    const msg: Record<string, unknown> = { role: "assistant", content: turn.text ?? null };
    if (turn.toolCalls && turn.toolCalls.length > 0) {
      msg.tool_calls = turn.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
    }
    return [msg];
  }
  return [{ role: "tool", tool_call_id: turn.toolCallId, content: turn.result }];
}

function safeParse(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const v = JSON.parse(s) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly model = "text-embedding-3-small";
  readonly dimension = 1536;
  private readonly baseUrl: string;
  constructor(
    private readonly apiKey: string,
    baseUrl: string = OPENAI_DEFAULT_BASE_URL,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async embed(texts: string[], opts: { deadlineMs?: number } = {}): Promise<number[][]> {
    const json = await aiFetch(
      "openai",
      `${this.baseUrl}/embeddings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, input: texts }),
      },
      { deadlineMs: opts.deadlineMs },
    );
    const data = (json.data ?? []) as Array<{ index: number; embedding: number[] }>;
    return data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
