import {
  aiFetch,
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  type ChatTurn,
  type ToolCall,
} from "./provider";

/** Anthropic Messages API mapping. */
export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic" as const;
  constructor(private readonly apiKey: string) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1024,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.system ? { system: req.system } : {}),
      messages: mapMessages(req.messages),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
    };

    const json = await aiFetch(
      "anthropic",
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      },
      { deadlineMs: req.deadlineMs },
    );

    const content = (json.content ?? []) as Array<{
      type: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
    const textParts = content.filter((c) => c.type === "text").map((c) => c.text ?? "");
    const toolCalls: ToolCall[] = content
      .filter((c) => c.type === "tool_use")
      .map((c) => ({ id: c.id ?? crypto.randomUUID(), name: c.name ?? "", arguments: c.input ?? {} }));

    const usage = (json.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
    return {
      text: textParts.length > 0 ? textParts.join("\n") : null,
      toolCalls,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      stopReason: (json.stop_reason as string | undefined) ?? null,
    };
  }
}

type AnthropicContent = Array<Record<string, unknown>>;

function mapMessages(turns: ChatTurn[]): Array<{ role: "user" | "assistant"; content: string | AnthropicContent }> {
  const out: Array<{ role: "user" | "assistant"; content: string | AnthropicContent }> = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      out.push({ role: "user", content: turn.text });
    } else if (turn.role === "assistant") {
      const content: AnthropicContent = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const tc of turn.toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      out.push({ role: "assistant", content: content.length > 0 ? content : [{ type: "text", text: "" }] });
    } else {
      // tool result → user turn with tool_result block
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: turn.toolCallId, content: turn.result }],
      });
    }
  }
  return out;
}
