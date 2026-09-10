import { describe, expect, it } from "vitest";
import { clampTextBytes, isWithinMessagingWindow, MAX_TEXT_BYTES } from "@/lib/meta/messaging";

describe("24h messaging window", () => {
  it("open when last user message is recent", () => {
    expect(isWithinMessagingWindow(new Date(Date.now() - 60_000))).toBe(true);
  });
  it("closed after 24h", () => {
    expect(isWithinMessagingWindow(new Date(Date.now() - 25 * 3600_000))).toBe(false);
  });
  it("closed when user never messaged", () => {
    expect(isWithinMessagingWindow(null)).toBe(false);
    expect(isWithinMessagingWindow(undefined)).toBe(false);
  });
});

describe("text byte clamping (Meta limit: 1000 UTF-8 bytes)", () => {
  it("keeps short text unchanged", () => {
    expect(clampTextBytes("hello")).toBe("hello");
  });
  it("clamps long ASCII to the byte budget", () => {
    const long = "a".repeat(1500);
    const out = clampTextBytes(long);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(out.endsWith("…")).toBe(true);
  });
  it("respects multibyte characters without splitting code points", () => {
    const long = "ў".repeat(900); // 2 bytes each = 1800 bytes
    const out = clampTextBytes(long);
    const bytes = new TextEncoder().encode(out);
    expect(bytes.length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    // decodes cleanly (no replacement chars from split code points)
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(out);
  });
});
