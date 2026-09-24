import { describe, expect, it } from "vitest";
import type { InstagramAccount } from "@prisma/client";
import {
  buildPrivateReplyMessage,
  clampTextBytes,
  isWithinMessagingWindow,
  MAX_TEXT_BYTES,
  replyToComment,
  sendPrivateReplyResourceToComment,
} from "@/lib/meta/messaging";

/** Enough of an account for the send layer; a demo account never touches Meta or the DB. */
const demoAccount = {
  id: "acc_demo",
  igUserId: "ig_demo",
  connectionMode: "INSTAGRAM_LOGIN",
  isDemo: true,
} as unknown as InstagramAccount;

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
 * Meta allows exactly ONE private reply per comment, and its message object
 * takes `attachment` OR `text` — never both. A second call is always rejected,
 * so these pin down that a resource + caption produces a single message, that
 * a caption which cannot travel is reported rather than dropped silently, and
 * that a resource only claims a native attachment when Instagram has one
 * (there is no generic "file" attachment, unlike Messenger).
 */
describe("buildPrivateReplyMessage", () => {
  it("plain text with no resource is a single text message", () => {
    expect(buildPrivateReplyMessage("hello", null)).toEqual({
      message: { text: "hello" },
      omittedText: null,
      omittedReason: null,
    });
  });

  it("an IMAGE/VIDEO resource attaches natively", () => {
    expect(buildPrivateReplyMessage("", { kind: "IMAGE", url: "https://x/img.jpg" })).toEqual({
      message: { attachment: { type: "image", payload: { url: "https://x/img.jpg", is_reusable: false } } },
      omittedText: null,
      omittedReason: null,
    });
    expect(buildPrivateReplyMessage("", { kind: "VIDEO", url: "https://x/v.mp4" })).toEqual({
      message: { attachment: { type: "video", payload: { url: "https://x/v.mp4", is_reusable: false } } },
      omittedText: null,
      omittedReason: null,
    });
  });

  it("a caption alongside a native attachment is reported as omitted, never queued as a second reply", () => {
    const payload = buildPrivateReplyMessage("here it is", { kind: "IMAGE", url: "https://x/img.jpg" });
    expect(payload.message).toEqual({
      attachment: { type: "image", payload: { url: "https://x/img.jpg", is_reusable: false } },
    });
    expect(payload.omittedText).toBe("here it is");
    expect(payload.omittedReason).toMatch(/one private reply/);
  });

  it("a blank caption omits nothing", () => {
    const payload = buildPrivateReplyMessage("   ", { kind: "IMAGE", url: "https://x/img.jpg" });
    expect(payload.omittedText).toBeNull();
    expect(payload.omittedReason).toBeNull();
  });

  it("a FILE resource (PDF/docs) has no native attachment — the link and the caption share the one text message", () => {
    expect(buildPrivateReplyMessage("Here's the price list:", { kind: "FILE", url: "https://x/price.pdf" })).toEqual({
      message: { text: "Here's the price list:\n\nhttps://x/price.pdf" },
      omittedText: null,
      omittedReason: null,
    });
  });

  /**
   * The link is the whole delivery, and it sits where the byte clamp cuts. A
   * caption inside its 900-CHARACTER rule limit is already over the 1000-BYTE
   * send limit in Cyrillic, which used to post a truncated sentence and a dead
   * "https…" stub while the run still recorded SUCCESS.
   */
  it("keeps the file link intact when a long caption would otherwise clamp it away", () => {
    const url = "https://app.example.com/r/ckv8x2j3k0001qwerty12345.pdf";
    const caption = "Ассалому алайкум! ".repeat(30); // 540 chars — allowed by the rule schema
    const payload = buildPrivateReplyMessage(caption, { kind: "FILE", url });
    const text = payload.message.text as string;

    expect(text.endsWith(url)).toBe(true);
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(text.length).toBeLessThan(caption.length + url.length); // the caption gave the ground, not the link
    expect(payload.omittedText).toBeNull(); // clamped, not dropped — the caption still arrives
  });

  it("reports the caption as omitted when the link alone fills the whole budget", () => {
    const url = `https://app.example.com/r/${"x".repeat(MAX_TEXT_BYTES)}.pdf`;
    const payload = buildPrivateReplyMessage("narxlar", { kind: "FILE", url });
    expect(payload.message).toEqual({ text: url });
    expect(payload.omittedText).toBe("narxlar");
    expect(payload.omittedReason).toMatch(/1000-byte/);
  });

  it("a link that leaves room for nothing but an ellipsis omits the caption rather than sending '…'", () => {
    // externalUrl is admin-pasted, so it can be long enough to crowd out the caption entirely.
    const url = `https://app.example.com/r/${"x".repeat(MAX_TEXT_BYTES - 34)}.pdf`;
    expect(MAX_TEXT_BYTES - (url.length + 2)).toBe(2); // room for less than the "…" itself
    const payload = buildPrivateReplyMessage("narxlar ro'yxati", { kind: "FILE", url });
    expect(payload.message).toEqual({ text: url });
    expect(payload.omittedText).toBe("narxlar ro'yxati");
  });
});

/**
 * A demo account exists so the whole pipeline is testable without a Meta app —
 * it must never reach the real API. Reaching it here would need a token from
 * the database, which these tests deliberately cannot provide.
 */
describe("demo accounts never call Meta", () => {
  it("a public comment reply short-circuits to a local id", async () => {
    const res = await replyToComment(demoAccount, "cmt_1", "rahmat!");
    expect(res.id).toMatch(/^demo-reply-/);
  });

  it("a resource private reply is ONE send, with the uncarried caption reported", async () => {
    const sent = await sendPrivateReplyResourceToComment(demoAccount, "cmt_1", "narxlar ro'yxati", {
      kind: "IMAGE",
      url: "https://x/img.jpg",
    });
    expect(sent.result.messageId).toMatch(/^demo-/);
    expect(sent.omittedText).toBe("narxlar ro'yxati");
  });
});
