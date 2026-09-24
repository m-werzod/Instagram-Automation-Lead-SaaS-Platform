import {
  aiFetch,
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatTurn,
  type EmbeddingProvider,
  type ToolCall,
} from "./provider";

/** Google Gemini (generativelanguage v1beta) mapping. */
export class GoogleProvider implements AIProvider {
  readonly name = "google" as const;
  constructor(private readonly apiKey: string) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const contents: Array<Record<string, unknown>> = [];
    for (const turn of req.messages) contents.push(mapTurn(turn));

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
      },
    };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (req.tools && req.tools.length > 0) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`;
    const json = await aiFetch(
      "google",
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
      },
      { deadlineMs: req.deadlineMs },
    );

    const candidate = (json.candidates as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
    const parts = ((candidate.content as { parts?: Array<Record<string, unknown>> } | undefined)?.parts ?? []) as Array<{
      text?: string;
      functionCall?: { name?: string; args?: Record<string, unknown> };
    }>;

    const textParts = parts.filter((p) => typeof p.text === "string").map((p) => p.text as string);
    const toolCalls: ToolCall[] = parts
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        // Gemini has no call ids — synthesize; results are matched by name.
        id: `${p.functionCall!.name ?? "fn"}-${i}`,
        name: p.functionCall!.name ?? "",
        arguments: p.functionCall!.args ?? {},
      }));

    const usage = (json.usageMetadata ?? {}) as { promptTokenCount?: number; candidatesTokenCount?: number };
    return {
      text: textParts.length > 0 ? textParts.join("\n") : null,
      toolCalls,
      inputTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      stopReason: (candidate.finishReason as string | undefined) ?? null,
    };
  }
}

function mapTurn(turn: ChatTurn): Record<string, unknown> {
  if (turn.role === "user") return { role: "user", parts: [{ text: turn.text }] };
  if (turn.role === "assistant") {
    const parts: Array<Record<string, unknown>> = [];
    if (turn.text) parts.push({ text: turn.text });
    for (const tc of turn.toolCalls ?? []) {
      parts.push({ functionCall: { name: tc.name, args: tc.arguments } });
    }
    return { role: "model", parts: parts.length > 0 ? parts : [{ text: "" }] };
  }
  return {
    role: "user",
    parts: [{ functionResponse: { name: turn.name, response: { result: turn.result } } }],
  };
}

export class GoogleEmbeddings implements EmbeddingProvider {
  readonly model = "text-embedding-004";
  readonly dimension = 768;
  constructor(private readonly apiKey: string) {}

  async embed(texts: string[], opts: { deadlineMs?: number } = {}): Promise<number[][]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents`;
    const json = await aiFetch(
      "google",
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify({
          requests: texts.map((t) => ({
            model: `models/${this.model}`,
            content: { parts: [{ text: t }] },
          })),
        }),
      },
      { deadlineMs: opts.deadlineMs },
    );
    const embeddings = (json.embeddings ?? []) as Array<{ values: number[] }>;
    return embeddings.map((e) => e.values);
  }
}
