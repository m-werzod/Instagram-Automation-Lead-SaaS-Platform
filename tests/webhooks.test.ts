import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";
import {
  dedupeKeyForDelivery,
  dedupeKeyForEvent,
  matchWebhookSecret,
  parseWebhookPayload,
  verifyWebhookSignature,
  type WebhookPayload,
  type WebhookSecret,
} from "@/lib/meta/webhooks";

const SECRET = "test-app-secret";
const IG_SECRET = "test-instagram-app-secret";

// The route is exercised against mocks only — unit tests never reach a DB or a
// queue. `after()` is Next's post-response hook and throws outside a real
// request scope, so it is stubbed; what is under test is the intake decision.
const db = vi.hoisted(() => ({
  findUnique: vi.fn(async (): Promise<{ id: string } | null> => null),
  create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "we_1", ...args.data })),
}));
const queue = vi.hoisted(() => ({ enqueue: vi.fn(async () => undefined), drainNow: vi.fn(async () => undefined) }));

vi.mock("@/lib/prisma", () => ({ prisma: { webhookEvent: db } }));
vi.mock("@/lib/queue", () => queue);
vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return { ...mod, after: (fn: () => unknown) => void fn };
});

const { GET, POST } = await import("@/app/api/webhooks/instagram/route");

function sign(body: string, secret: string = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
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

describe("dual-app signature matching", () => {
  // Instagram Login and the Facebook app are separate Meta apps with separate
  // secrets; either may be the one that signed a delivery.
  const secrets: WebhookSecret[] = [
    { source: "instagram", secret: IG_SECRET },
    { source: "facebook", secret: SECRET },
  ];

  it("accepts a delivery signed with the Instagram app secret", () => {
    const body = JSON.stringify({ object: "instagram", entry: [] });
    expect(matchWebhookSecret(body, sign(body, IG_SECRET), secrets)).toBe("instagram");
  });

  it("accepts a delivery signed with the Facebook app secret", () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    expect(matchWebhookSecret(body, sign(body, SECRET), secrets)).toBe("facebook");
  });

  it("rejects a delivery signed with neither secret, and unsigned deliveries", () => {
    const body = "{}";
    expect(matchWebhookSecret(body, sign(body, "third-app"), secrets)).toBeNull();
    expect(matchWebhookSecret(body, null, secrets)).toBeNull();
  });

  it("rejects everything when no secret is configured", () => {
    const body = "{}";
    expect(matchWebhookSecret(body, sign(body), [])).toBeNull();
  });

  /**
   * An installation that only has one of the two apps set up must still reject
   * the other app's deliveries — accepting both secrets is not the same as
   * accepting any signature.
   */
  it("rejects the other app's delivery when only one app is configured", () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    expect(matchWebhookSecret(body, sign(body, SECRET), [{ source: "instagram", secret: IG_SECRET }])).toBeNull();
    expect(matchWebhookSecret(body, sign(body, IG_SECRET), [{ source: "facebook", secret: SECRET }])).toBeNull();
  });

  // The route lists Instagram first only as an ordering preference; which app
  // signed a delivery must not depend on it.
  it("accepts either app whichever order the secrets are configured in", () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    const reversed: WebhookSecret[] = [...secrets].reverse();
    expect(matchWebhookSecret(body, sign(body, SECRET), reversed)).toBe("facebook");
    expect(matchWebhookSecret(body, sign(body, IG_SECRET), reversed)).toBe("instagram");
  });

  it("still requires the body to match the signature it was given", () => {
    expect(matchWebhookSecret("{}", sign("{\"a\":1}", IG_SECRET), secrets)).toBeNull();
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

describe("delivery dedupe key", () => {
  /** A batched comment delivery — `count` comments with long, realistic ids. */
  function commentBatch(count: number, suffix = ""): WebhookPayload {
    return {
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          time: 1700000000,
          changes: Array.from({ length: count }, (_, i) => ({
            field: "comments",
            value: { id: `179876543210${String(i).padStart(4, "0")}${suffix}`, text: "narx?" },
          })),
        },
      ],
    };
  }

  const keyFor = (p: WebhookPayload) => dedupeKeyForDelivery(parseWebhookPayload(p), JSON.stringify(p));

  it("is identical for a redelivery of the same batch", () => {
    expect(keyFor(commentBatch(3))).toBe(keyFor(commentBatch(3)));
  });

  it("separates two long batches that share a 500-char prefix", () => {
    const first = commentBatch(30);
    const longer = commentBatch(31);
    // The condition the old truncation lost: the joined keys agree far past the
    // cut, so a prefix could not tell the two deliveries apart.
    const joined = (p: WebhookPayload) => parseWebhookPayload(p).map(dedupeKeyForEvent).join("|");
    expect(joined(longer).startsWith(joined(first))).toBe(true);
    expect(joined(first).length).toBeGreaterThan(500);
    expect(keyFor(first)).not.toBe(keyFor(longer));
  });

  it("is fixed-length however large the batch", () => {
    expect(keyFor(commentBatch(1))).toHaveLength("ev:".length + 64);
    expect(keyFor(commentBatch(200))).toHaveLength("ev:".length + 64);
  });

  /**
   * WebhookEvent.dedupeKey is shared with rows other code paths write straight
   * into it — handlers.ts claims a comment with `cmt:handled:<id>`, the dev
   * simulator inserts `msg:<mid>`. A delivery key that reused one of those
   * shapes would let such a row swallow a real delivery as a "duplicate", so it
   * has to stay in its own namespace.
   */
  it("keeps the delivery key in its own namespace, apart from per-event keys", () => {
    const single: WebhookPayload = {
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          time: 1700000000000,
          messaging: [{ sender: { id: "1234" }, recipient: { id: "17841400000000000" }, message: { mid: "m-1" } }],
        },
      ],
    };
    expect(dedupeKeyForEvent(parseWebhookPayload(single)[0]!)).toBe("msg:m-1");
    expect(keyFor(single)).not.toBe("msg:m-1");
    expect(keyFor(single).startsWith("ev:")).toBe(true);
  });

  it("falls back to a body hash when the payload carries no events", () => {
    const empty: WebhookPayload = { object: "instagram", entry: [] };
    expect(keyFor(empty)).toBe(dedupeKeyForDelivery([], JSON.stringify(empty)));
    expect(keyFor(empty).startsWith("raw:")).toBe(true);
    expect(keyFor(empty)).not.toBe(dedupeKeyForDelivery([], "{}"));
  });
});

/**
 * The helper above proves a list of secrets is matched correctly; these prove
 * the ROUTE hands it the right list. That is where the outage lived: every real
 * DM and comment is signed by the Instagram Login app, and checking only
 * META_APP_SECRET rejected all of them as forged while the helper's own tests
 * would still have passed.
 *
 * The secrets are the ones vitest.config.ts puts in the environment, and they
 * are deliberately different values.
 */
describe("webhook route intake", () => {
  const URL = "http://localhost:3000/api/webhooks/instagram";
  const ENV_IG_SECRET = "test-ig-app-secret";
  const ENV_FB_SECRET = "test-fb-app-secret";

  const dmBody = JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: "17841400000000000",
        time: 1700000000000,
        messaging: [{ sender: { id: "1234" }, recipient: { id: "17841400000000000" }, message: { mid: "mid.route", text: "salom" } }],
      },
    ],
  });
  const leadgenBody = JSON.stringify({
    object: "page",
    entry: [{ id: "page1", time: 1700000000, changes: [{ field: "leadgen", value: { leadgen_id: "L9", form_id: "F9" } }] }],
  });

  function post(body: string, signature?: string) {
    const headers = new Headers({ "content-type": "application/json" });
    if (signature) headers.set("x-hub-signature-256", signature);
    return new NextRequest(URL, { method: "POST", headers, body });
  }

  beforeEach(() => {
    db.findUnique.mockClear().mockResolvedValue(null);
    db.create.mockClear();
    queue.enqueue.mockClear();
  });

  it("accepts a DM signed by the Instagram Login app", async () => {
    const res = await POST(post(dmBody, sign(dmBody, ENV_IG_SECRET)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    expect(db.create).toHaveBeenCalledTimes(1);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("still accepts Page leadgen signed by the Facebook app", async () => {
    const res = await POST(post(leadgenBody, sign(leadgenBody, ENV_FB_SECRET)));
    expect(res.status).toBe(200);
    expect(db.create).toHaveBeenCalledTimes(1);
  });

  it("rejects an unsigned, wrongly-signed or tampered delivery without storing it", async () => {
    for (const req of [
      post(dmBody),
      post(dmBody, sign(dmBody, "some-other-app")),
      post(dmBody, sign(dmBody + " ", ENV_IG_SECRET)),
    ]) {
      const res = await POST(req);
      expect(res.status).toBe(401);
    }
    expect(db.create).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("stores the hashed delivery key, not a per-event key a marker row could shadow", async () => {
    await POST(post(dmBody, sign(dmBody, ENV_IG_SECRET)));
    const data = db.create.mock.calls[0]![0]!.data as { dedupeKey: string; signatureValid: boolean; object: string };
    expect(data.dedupeKey.startsWith("ev:")).toBe(true);
    expect(data.dedupeKey).not.toBe("msg:mid.route");
    expect(data.signatureValid).toBe(true);
    expect(data.object).toBe("instagram");
  });

  it("acknowledges a redelivery without reprocessing it", async () => {
    db.findUnique.mockResolvedValue({ id: "we_existing" });
    const res = await POST(post(dmBody, sign(dmBody, ENV_IG_SECRET)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    expect(db.create).not.toHaveBeenCalled();
  });

  it("echoes the challenge only for the right verify token", async () => {
    const handshake = (token: string) =>
      GET(new NextRequest(`${URL}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=echo-me`));

    const okRes = await handshake("test-verify-token");
    expect(okRes.status).toBe(200);
    expect(await okRes.text()).toBe("echo-me");
    // A prefix must not be treated as a match — the compare is length-checked
    // and constant-time.
    expect((await handshake("test-verify-toke")).status).toBe(403);
    expect((await handshake("wrong")).status).toBe(403);
  });
});
