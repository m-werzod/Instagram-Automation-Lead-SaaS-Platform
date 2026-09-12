import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "@/lib/ai/openai";
import { aiFetch, AIProviderError } from "@/lib/ai/provider";
import { defaultModelFor, aiRuntimeInfo } from "@/lib/ai";

/**
 * The OpenAI provider doubles as the adapter for every OpenAI-compatible
 * gateway (api.airforce in this deployment). These tests pin the parts that
 * differ from the official API — base URL, token parameter, reported cost —
 * and the transport rules every provider shares: hard timeout, one retry for
 * transient failures only, readable errors for the rest.
 */

const req = { model: "ministral-14b-latest", system: "s", messages: [{ role: "user" as const, text: "hi" }], maxTokens: 300 };

function okResponse(json: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(json), { status: 200, ...init });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenAIProvider against a gateway", () => {
  it("posts to the configured base URL and uses max_tokens there", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: "Salom!" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.00005 } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await new OpenAIProvider("k", "https://api.airforce/v1/").chat(req);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.airforce/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.max_tokens).toBe(300);
    expect(body.max_completion_tokens).toBeUndefined();
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer k" });
    expect(res.text).toBe("Salom!");
    // the gateway's exact charge is kept, not estimated
    expect(res.costUsd).toBeCloseTo(0.00005);
  });

  it("keeps the official parameter name for api.openai.com and reports no cost", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: "Hi" } }], usage: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await new OpenAIProvider("k").chat(req);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(body.max_completion_tokens).toBe(300);
    expect(res.costUsd).toBeNull();
  });

  it("synthesises tool-call ids when a gateway omits them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        okResponse({ choices: [{ message: { tool_calls: [{ id: "", function: { name: "create_lead", arguments: "{}" } }] } }], usage: {} }),
      ),
    );
    const res = await new OpenAIProvider("k", "https://gw.example/v1").chat(req);
    expect(res.toolCalls[0]!.id).toBe("call_0");
  });
});

describe("aiFetch transport rules", () => {
  it("does NOT retry a 429 and exposes Retry-After as a readable message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429, headers: { "retry-after": "42" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const err = await aiFetch("openai", "https://gw/v1/x", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AIProviderError);
    const e = err as AIProviderError;
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.retryAfterSec).toBe(42);
    expect(e.userMessage).toMatch(/42s/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx once and returns the recovered body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream down", { status: 503 }))
      .mockResolvedValueOnce(okResponse({ ok: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const p = aiFetch("openai", "https://gw/v1/x", {});
    await vi.runAllTimersAsync();
    expect(await p).toEqual({ ok: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a paid-model refusal (402) as permanent with an actionable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Model requires an active subscription", code: "402" } }), { status: 402 })),
    );
    const err = (await aiFetch("openai", "https://gw/v1/x", {}).catch((e: unknown) => e)) as AIProviderError;
    expect(err.retryable).toBe(false);
    expect(err.userMessage).toMatch(/paid plan/);
  });

  it("aborts on timeout and reports it as a retryable 408 after one retry", async () => {
    const abort = () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      return Promise.reject(e);
    };
    const fetchMock = vi.fn().mockImplementation(abort);
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const p = aiFetch("openai", "https://gw/v1/x", {}, { timeoutMs: 5000 });
    const settled = p.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await settled) as AIProviderError;
    expect(err).toBeInstanceOf(AIProviderError);
    expect(err.status).toBe(408);
    expect(err.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("configured defaults", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.AI_PROVIDER = "openai";
    process.env.AI_API_KEY = "sk-test";
    process.env.AI_API_BASE_URL = "https://api.airforce/v1";
    process.env.AI_MODEL = "ministral-14b-latest";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("pins the operator's model for the default provider only", () => {
    expect(defaultModelFor("openai")).toBe("ministral-14b-latest");
    expect(defaultModelFor("anthropic")).toBe("claude-sonnet-4-5");
  });

  it("describes the runtime without exposing the key", () => {
    const info = aiRuntimeInfo();
    expect(info).toEqual({ provider: "openai", configured: true, model: "ministral-14b-latest", host: "api.airforce" });
    expect(JSON.stringify(info)).not.toContain("sk-test");
  });
});
