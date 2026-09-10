import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import {
  dedupeKeyForEvent,
  parseWebhookPayload,
  verifyWebhookSignature,
  type WebhookPayload,
} from "@/lib/meta/webhooks";

const SECRET = "test-app-secret";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

describe("webhook signature validation", () => {
  it("accepts a valid signature", () => {
    const body = JSON.stringify({ object: "instagram", entry: [] });
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const body = JSON.stringify({ object: "instagram" });
    expect(verifyWebhookSignature(body, "sha256=" + "0".repeat(64), SECRET)).toBe(false);
  });

  it("rejects missing or malformed headers", () => {
    expect(verifyWebhookSignature("x", null, SECRET)).toBe(false);
    expect(verifyWebhookSignature("x", "md5=abc", SECRET)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const body = "{}";
    const wrong = "sha256=" + createHmac("sha256", "other").update(body).digest("hex");
    expect(verifyWebhookSignature(body, wrong, SECRET)).toBe(false);
  });
});

describe("webhook payload parsing", () => {
  const messagePayload: WebhookPayload = {
    object: "instagram",
    entry: [
      {
        id: "17841400000000000",
        time: 1700000000000,
        messaging: [
          {
            sender: { id: "1234" },
            recipient: { id: "17841400000000000" },
            timestamp: 1700000000001,
            message: { mid: "mid.abc", text: "Hello", quick_reply: { payload: "lf_opt:1" } },
          },
        ],
      },
    ],
  };

  it("normalizes message events", () => {
    const events = parseWebhookPayload(messagePayload);
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("message");
    if (ev.type === "message") {
      expect(ev.senderIgsid).toBe("1234");
      expect(ev.mid).toBe("mid.abc");
      expect(ev.text).toBe("Hello");
      expect(ev.quickReplyPayload).toBe("lf_opt:1");
      expect(ev.isEcho).toBe(false);
    }
  });

  it("flags echo messages", () => {
    const echo: WebhookPayload = JSON.parse(JSON.stringify(messagePayload)) as WebhookPayload;
    echo.entry![0]!.messaging![0]!.message!.is_echo = true;
    const events = parseWebhookPayload(echo);
    expect(events[0]!.type).toBe("message");
    if (events[0]!.type === "message") expect(events[0]!.isEcho).toBe(true);
  });

  it("normalizes comment change events", () => {
    const events = parseWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: "178414",
          time: 1700000000,
          changes: [
            {
              field: "comments",
              value: { id: "c1", media: { id: "m1" }, text: "narx?", from: { id: "u9", username: "buyer" } },
            },
          ],
        },
      ],
    });
    expect(events[0]!.type).toBe("comment");
    if (events[0]!.type === "comment") {
      expect(events[0]!.commentId).toBe("c1");
      expect(events[0]!.mediaId).toBe("m1");
      expect(events[0]!.fromUsername).toBe("buyer");
    }
  });

  it("normalizes leadgen events", () => {
    const events = parseWebhookPayload({
      object: "page",
      entry: [{ id: "page1", time: 1, changes: [{ field: "leadgen", value: { leadgen_id: "L1", form_id: "F1" } }] }],
    });
    expect(events[0]!.type).toBe("leadgen");
  });

  it("dedupe keys are stable and unique per event identity", () => {
    const [a] = parseWebhookPayload(messagePayload);
    const [b] = parseWebhookPayload(messagePayload);
    expect(dedupeKeyForEvent(a!)).toBe(dedupeKeyForEvent(b!));
    expect(dedupeKeyForEvent(a!)).toBe("msg:mid.abc");
  });
});
