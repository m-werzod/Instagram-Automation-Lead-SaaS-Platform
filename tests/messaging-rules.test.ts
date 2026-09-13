import { describe, expect, it } from "vitest";
import { buildResourceMessages, clampTextBytes, isWithinMessagingWindow, MAX_TEXT_BYTES } from "@/lib/meta/messaging";

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

/**
 * Instagram's Send API documents image/video/audio attachment TYPES only —
 * there is no generic "file" attachment (unlike Messenger) — so these pin
 * down exactly when a resource attaches natively vs. degrades to a link,
 * never silently claiming a capability Meta doesn't have.
 */
describe("buildResourceMessages", () => {
  it("plain text with no resource is a single text message", () => {
    expect(buildResourceMessages("hello", null)).toEqual([{ text: "hello" }]);
  });

  it("an IMAGE/VIDEO resource attaches natively as its own message", () => {
    expect(buildResourceMessages("", { kind: "IMAGE", url: "https://x/img.jpg" })).toEqual([
      { attachment: { type: "image", payload: { url: "https://x/img.jpg", is_reusable: false } } },
    ]);
    expect(buildResourceMessages("", { kind: "VIDEO", url: "https://x/v.mp4" })).toEqual([
      { attachment: { type: "video", payload: { url: "https://x/v.mp4", is_reusable: false } } },
    ]);
  });

  it("caption text alongside an IMAGE/VIDEO attachment is a separate second message, not a combined payload", () => {
    const messages = buildResourceMessages("here it is", { kind: "IMAGE", url: "https://x/img.jpg" });
    expect(messages).toEqual([
      { attachment: { type: "image", payload: { url: "https://x/img.jpg", is_reusable: false } } },
      { text: "here it is" },
    ]);
  });

  it("blank caption alongside an attachment sends only the attachment", () => {
    expect(buildResourceMessages("   ", { kind: "IMAGE", url: "https://x/img.jpg" })).toHaveLength(1);
  });

  it("a FILE resource (PDF/docs) has no native attachment — sends a link inside the text instead", () => {
    const messages = buildResourceMessages("Here's the price list:", { kind: "FILE", url: "https://x/price.pdf" });
    expect(messages).toEqual([{ text: "Here's the price list:\n\nhttps://x/price.pdf" }]);
  });
});
