import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "@/lib/ai/anthropic";
import { OpenAIProvider } from "@/lib/ai/openai";
import { GoogleProvider } from "@/lib/ai/google";
import { estimateCostUsd } from "@/lib/ai";
import type { ChatRequest } from "@/lib/ai/provider";

const baseReq: ChatRequest = {
  model: "test-model",
  system: "sys",
  messages: [
    { role: "user", text: "Hi" },
    { role: "assistant", text: "Hello", toolCalls: [{ id: "t1", name: "get_business_knowledge", arguments: { query: "price" } }] },
    { role: "tool", toolCallId: "t1", name: "get_business_knowledge", result: "Course costs 1.2M UZS" },
  ],
  tools: [{ name: "get_business_knowledge", description: "d", parameters: { type: "object", properties: {} } }],
  temperature: 0.5,
  maxTokens: 256,
};

function mockFetchOnce(json: unknown) {
  const fn = vi.fn().mockResolvedValue(new Response(JSON.stringify(json), { status: 200 }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe("AnthropicProvider", () => {
  it("maps request and parses text + tool calls + usage", async () => {
    const fetchMock = mockFetchOnce({
      content: [
        { type: "text", text: "Answer" },
        { type: "tool_use", id: "tu1", name: "create_lead", input: { name: "Aziz" } },
      ],
      usage: { input_tokens: 100, output_tokens: 20 },
      stop_reason: "tool_use",
    });

    const res = await new AnthropicProvider("k").chat(baseReq);
    expect(res.text).toBe("Answer");
    expect(res.toolCalls).toEqual([{ id: "tu1", name: "create_lead", arguments: { name: "Aziz" } }]);
    expect(res.inputTokens).toBe(100);
    expect(res.outputTokens).toBe(20);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.system).toBe("sys");
    expect(body.max_tokens).toBe(256);
    // tool result mapped into a user turn with tool_result block
    const toolResultTurn = body.messages.at(-1);
    expect(toolResultTurn.role).toBe("user");
    expect(toolResultTurn.content[0].type).toBe("tool_result");
    expect(toolResultTurn.content[0].tool_use_id).toBe("t1");
    // assistant tool_use preserved
    const assistantTurn = body.messages[1];
    expect(assistantTurn.content.some((c: { type: string }) => c.type === "tool_use")).toBe(true);
  });
});

describe("OpenAIProvider", () => {
  it("maps request and parses tool_calls with JSON arguments", async () => {
    const fetchMock = mockFetchOnce({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "c1", function: { name: "create_lead", arguments: '{"name":"Aziz"}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });

    const res = await new OpenAIProvider("k").chat(baseReq);
    expect(res.toolCalls[0]).toEqual({ id: "c1", name: "create_lead", arguments: { name: "Aziz" } });
    expect(res.inputTokens).toBe(50);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages.at(-1).role).toBe("tool");
    expect(body.messages.at(-1).tool_call_id).toBe("t1");
    expect(body.tools[0].type).toBe("function");
  });

  it("survives malformed tool-call arguments", async () => {
    mockFetchOnce({
      choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "x", arguments: "{broken" } }] } }],
      usage: {},
    });
    const res = await new OpenAIProvider("k").chat(baseReq);
    expect(res.toolCalls[0]!.arguments).toEqual({});
  });
});

describe("GoogleProvider", () => {
  it("maps request and parses functionCall parts", async () => {
    const fetchMock = mockFetchOnce({
      candidates: [
        {
          content: { parts: [{ text: "Ok" }, { functionCall: { name: "create_lead", args: { name: "Aziz" } } }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 5 },
    });

    const res = await new GoogleProvider("k").chat(baseReq);
    expect(res.text).toBe("Ok");
    expect(res.toolCalls[0]!.name).toBe("create_lead");
    expect(res.inputTokens).toBe(30);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("models/test-model:generateContent");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.systemInstruction.parts[0].text).toBe("sys");
    // tool result becomes functionResponse under role user
    const last = body.contents.at(-1);
    expect(last.role).toBe("user");
    expect(last.parts[0].functionResponse.name).toBe("get_business_knowledge");
  });
});

describe("cost estimation", () => {
  it("estimates known models and returns null for unknown", () => {
    const cost = estimateCostUsd("claude-sonnet-4-5-20250929", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(18);
    expect(estimateCostUsd("mystery-model", 1000, 1000)).toBeNull();
  });
});
