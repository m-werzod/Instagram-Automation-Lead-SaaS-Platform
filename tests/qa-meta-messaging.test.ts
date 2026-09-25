import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import { NextRequest } from "next/server";
import type { InstagramAccount, LeadFlowQuestion } from "@prisma/client";

import {
  dedupeKeyForDelivery,
  dedupeKeyForEvent,
  matchWebhookSecret,
  parseWebhookPayload,
  verifyWebhookSignature,
  type NormalizedEvent,
  type WebhookPayload,
  type WebhookSecret,
} from "@/lib/meta/webhooks";
import {
  MAX_QUICK_REPLIES,
  MAX_QUICK_REPLY_TITLE,
  MAX_TEXT_BYTES,
  MESSAGING_WINDOW_MS,
  clampTextBytes,
  isWithinMessagingWindow,
  sendInstagramText,
  sendPrivateReplyToComment,
} from "@/lib/meta/messaging";
import {
  buildState,
  fbExchangeCode,
  fbExchangeLongLived,
  igExchangeCode,
  igExchangeLongLived,
  igLoginScopes,
  igRefreshLongLived,
  verifyState,
} from "@/lib/meta/oauth";
import { capabilityMap, detectCapabilities, type AccountWithAuth } from "@/lib/meta/capabilities";
import { allConditionsMatch, conditionMatches, isWithinCooldown, runAutomations } from "@/lib/automation/engine";
import {
  CANCEL_KEYWORDS,
  SESSION_EXPIRY_MS,
  OPTION_PAYLOAD_PREFIX,
  findFlowByKeyword,
  getActiveSession,
  handleFlowAnswer,
  keywordMatches,
  startFlowSession,
} from "@/lib/leadflow/engine";
import { _resetRateLimiter, LIMITS, rateLimit } from "@/lib/rate-limit";

/* ------------------------------------------------------------------ *
 * In-memory Prisma stand-in (pattern: tests/video-render.test.ts).
 * Real handler logic runs end to end against it — no database exists in
 * this environment and none can be started.
 * ------------------------------------------------------------------ */

/** What an assertion sees when it reads back a captured Graph request body. */
type GraphBody = {
  recipient?: { id?: string };
  message?: { text?: string; quick_replies?: Array<Record<string, string>>; attachment?: Record<string, unknown> };
  [key: string]: unknown;
};

const { store, db, graphMock, queueMock, emailMock } = vi.hoisted(() => {
  type Row = Record<string, unknown>;

  const store = {
    seq: 0,
    globalSettings: [] as Row[],
    automation: [] as Row[],
    automationRun: [] as Row[],
    instagramAccount: [] as Row[],
    commentResource: [] as Row[],
    conversation: [] as Row[],
    message: [] as Row[],
    leadFlow: [] as Row[],
    leadFlowQuestion: [] as Row[],
    leadFlowSession: [] as Row[],
    leadAnswer: [] as Row[],
    lead: [] as Row[],
    leadEvent: [] as Row[],
    ctaConfig: [] as Row[],
    aIAgent: [] as Row[],
    webhookEvent: [] as Row[],
  };

  /** The subset of Prisma's query shape this stand-in understands. */
  interface QueryArgs {
    [key: string]: unknown;
    data?: Row | Row[];
    where?: Row;
    orderBy?: Row | Row[];
    take?: number;
    select?: Record<string, boolean>;
    include?: Record<string, unknown>;
    update?: Row;
    create?: Row;
  }

  const OPS = new Set(["in", "notIn", "lt", "lte", "gt", "gte", "not", "equals"]);
  const val = (v: unknown): number | string => (v instanceof Date ? v.getTime() : (v as number | string));
  const eq = (a: unknown, b: unknown): boolean => val(a) === val(b);

  function matches(row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
      if (key === "AND") return (cond as Row[]).every((c) => matches(row, c));
      const value = row[key];
      if (cond !== null && cond !== undefined && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
        const c = cond as Record<string, unknown>;
        if (Object.keys(c).some((k) => OPS.has(k))) {
          if ("in" in c) return (c.in as unknown[]).map(val).includes(val(value));
          if ("notIn" in c) return !(c.notIn as unknown[]).map(val).includes(val(value));
          if ("lt" in c) return value != null && val(value) < val(c.lt);
          if ("lte" in c) return value != null && val(value) <= val(c.lte);
          if ("gt" in c) return value != null && val(value) > val(c.gt);
          if ("gte" in c) return value != null && val(value) >= val(c.gte);
          if ("not" in c) return !eq(value, c.not);
          if ("equals" in c) return eq(value, c.equals);
          return false;
        }
        // composite unique key, e.g. { sessionId_questionId: { sessionId, questionId } }
        return matches(row, c);
      }
      return eq(value, cond);
    });
  }

  function flattenWhere(where: Row): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(where ?? {})) {
      if (v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) Object.assign(out, flattenWhere(v as Row));
      else out[k] = v;
    }
    return out;
  }

  function applyData(row: Row, data: Row | Row[] | undefined): void {
    for (const [k, v] of Object.entries((Array.isArray(data) ? data[0] : data) ?? {})) {
      if (v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v) && "increment" in (v as Row)) {
        row[k] = ((row[k] as number) ?? 0) + Number((v as Row).increment);
      } else {
        row[k] = v;
      }
    }
    row.updatedAt = new Date();
  }

  function sortRows(list: Row[], orderBy: unknown): Row[] {
    if (!orderBy) return list;
    const specs: Row[] = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...list].sort((a, b) => {
      for (const spec of specs) {
        for (const [key, dir] of Object.entries(spec)) {
          const av = val(a[key]);
          const bv = val(b[key]);
          if (av === bv) continue;
          const less = av === null || av === undefined ? true : bv === null || bv === undefined ? false : av < bv;
          return (less ? -1 : 1) * (dir === "desc" ? -1 : 1);
        }
      }
      return 0;
    });
  }

  type Hydrate = (row: Row, args: Row) => Row;

  /** Column defaults the real schema applies on insert (@default in schema.prisma). */
  function table(name: keyof typeof store, hydrate?: Hydrate, defaults: () => Row = () => ({})) {
    const rows = () => store[name] as Row[];
    const out = (row: Row, args: Row = {}) => (hydrate ? hydrate({ ...row }, args) : { ...row });
    const find = (where: Row | undefined) => rows().find((r) => matches(r, where));
    return {
      create: async (args: QueryArgs) => {
        const row: Row = {
          id: `${String(name)}_${++store.seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...defaults(),
          ...args.data,
        };
        rows().push(row);
        return out(row, args);
      },
      createMany: async (args: QueryArgs) => {
        for (const data of args.data as Row[]) rows().push({ id: `${String(name)}_${++store.seq}`, createdAt: new Date(), ...data });
        return { count: (args.data as Row[]).length };
      },
      findUnique: async (args: QueryArgs) => {
        const row = find(args.where);
        return row ? out(row, args) : null;
      },
      findUniqueOrThrow: async (args: QueryArgs) => {
        const row = find(args.where);
        if (!row) throw new Error(`${String(name)}: record not found`);
        return out(row, args);
      },
      findFirst: async (args: QueryArgs = {}) => {
        const row = sortRows(rows().filter((r) => matches(r, args.where)), args.orderBy)[0];
        return row ? out(row, args) : null;
      },
      findMany: async (args: QueryArgs = {}) => {
        const list = sortRows(rows().filter((r) => matches(r, args.where)), args.orderBy);
        return (args.take ? list.slice(0, args.take) : list).map((r) => out(r, args));
      },
      count: async (args: QueryArgs = {}) => rows().filter((r) => matches(r, args.where)).length,
      update: async (args: QueryArgs) => {
        const row = find(args.where);
        if (!row) throw new Error(`${String(name)}: record not found`);
        applyData(row, args.data);
        return out(row, args);
      },
      updateMany: async (args: QueryArgs) => {
        const hit = rows().filter((r) => matches(r, args.where));
        for (const row of hit) applyData(row, args.data);
        return { count: hit.length };
      },
      upsert: async (args: QueryArgs) => {
        const row = find(args.where);
        if (row) {
          applyData(row, args.update);
          return out(row, args);
        }
        const created: Row = {
          id: `${String(name)}_${++store.seq}`,
          createdAt: new Date(),
          ...flattenWhere(args.where ?? {}),
          ...args.create,
        };
        rows().push(created);
        return out(created, args);
      },
      delete: async (args: QueryArgs) => {
        const i = rows().findIndex((r) => matches(r, args.where));
        if (i === -1) throw new Error(`${String(name)}: record not found`);
        return rows().splice(i, 1)[0];
      },
      deleteMany: async (args: QueryArgs = {}) => {
        const keep = rows().filter((r) => !matches(r, args.where));
        const removed = rows().length - keep.length;
        (store[name] as Row[]).length = 0;
        (store[name] as Row[]).push(...keep);
        return { count: removed };
      },
    };
  }

  const db: Record<string, unknown> = {
    globalSettings: table("globalSettings"),
    automation: table("automation"),
    automationRun: table("automationRun"),
    instagramAccount: table("instagramAccount"),
    commentResource: table("commentResource"),
    message: table("message"),
    lead: table("lead"),
    leadEvent: table("leadEvent"),
    ctaConfig: table("ctaConfig"),
    aIAgent: table("aIAgent"),
    leadAnswer: table("leadAnswer"),
    leadFlowQuestion: table("leadFlowQuestion"),
    webhookEvent: table("webhookEvent"),
    conversation: table("conversation", (row, args) => {
      if ((args.include as Row | undefined)?.account) {
        row.account = store.instagramAccount.find((a) => a.id === row.accountId) ?? null;
      }
      return row;
    }),
    leadFlow: table("leadFlow", (row, args) => {
      const include = args.include as Row | undefined;
      if (include?.questions) {
        const spec = (include.questions === true ? {} : include.questions) as Row;
        row.questions = sortRows(
          store.leadFlowQuestion.filter((q) => q.flowId === row.id && matches(q, spec.where as Row | undefined)),
          spec.orderBy,
        ).map((q) => ({ ...q }));
      }
      return row;
    }),
    leadFlowSession: table(
      "leadFlowSession",
      (row, args) => {
      const include = args.include as Row | undefined;
      if (!include) return row;
      if (include.flow) row.flow = { ...(store.leadFlow.find((f) => f.id === row.flowId) ?? {}) };
      if (include.conversation) row.conversation = { ...(store.conversation.find((c) => c.id === row.conversationId) ?? {}) };
        if (include.answers) {
          const nested = (include.answers === true ? {} : include.answers) as Row;
          row.answers = store.leadAnswer
            .filter((a) => a.sessionId === row.id)
            .map((a) => ({
              ...a,
              ...((nested.include as Row | undefined)?.question
                ? { question: { ...(store.leadFlowQuestion.find((q) => q.id === a.questionId) ?? {}) } }
                : {}),
            }));
        }
        return row;
      },
      // @default(ACTIVE) / @default(now()) in schema.prisma
      () => ({ status: "ACTIVE", startedAt: new Date(), completedAt: null, leadId: null, currentQuestionId: null, askedAt: null }),
    ),
    $transaction: async (arg: unknown) =>
      typeof arg === "function" ? (arg as (c: unknown) => unknown)(db) : Promise.all(arg as readonly unknown[]),
  };

  return {
    store,
    db,
    graphMock: vi.fn(async (_args: { host: string; method?: string; path: string; body?: Record<string, unknown> }) => ({
      recipient_id: "igsid_1",
      message_id: `mid_${Math.random().toString(36).slice(2)}`,
      id: "reply_1",
    })),
    queueMock: { enqueue: vi.fn(async () => undefined), drainNow: vi.fn(async () => undefined) },
    emailMock: { queueAdminAlert: vi.fn(async () => undefined) },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: db }));
vi.mock("@/lib/queue", () => queueMock);
vi.mock("@/lib/email", () => emailMock);
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  graphCall: graphMock,
}));
vi.mock("@/lib/meta/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/tokens")>()),
  resolveAccess: vi.fn(async () => ({ host: "graph.instagram.com", accessToken: "tok" })),
}));
vi.mock("next/server", async (importOriginal) => {
  const mod = await importOriginal<typeof import("next/server")>();
  return { ...mod, after: (fn: () => unknown) => void fn };
});

const { POST: WEBHOOK_POST, GET: WEBHOOK_GET } = await import("@/app/api/webhooks/instagram/route");

const ENV_IG_SECRET = "test-ig-app-secret";
const ENV_FB_SECRET = "test-fb-app-secret";

function resetStore(): void {
  for (const [, value] of Object.entries(store)) {
    if (Array.isArray(value)) value.length = 0;
  }
  store.seq = 0;
  store.globalSettings.push({ id: 1, masterAutomationEnabled: true, leadAutomationWhenOff: true });
}

beforeEach(() => {
  resetStore();
  graphMock.mockClear();
  queueMock.enqueue.mockClear();
  emailMock.queueAdminAlert.mockClear();
  _resetRateLimiter();
});

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

/* ================================================================== *
 * 1. Webhook signature verification
 * ================================================================== */

describe("webhook signature verification", () => {
  const secrets: WebhookSecret[] = [
    { source: "instagram", secret: ENV_IG_SECRET },
    { source: "facebook", secret: ENV_FB_SECRET },
  ];
  const body = JSON.stringify({ object: "instagram", entry: [{ id: "1", time: 1700000000 }] });

  it("accepts a delivery signed with either app's secret and names which app signed it", () => {
    expect(matchWebhookSecret(body, sign(body, ENV_IG_SECRET), secrets)).toBe("instagram");
    expect(matchWebhookSecret(body, sign(body, ENV_FB_SECRET), secrets)).toBe("facebook");
  });

  it("rejects an unsigned delivery", () => {
    expect(matchWebhookSecret(body, null, secrets)).toBeNull();
    expect(matchWebhookSecret(body, "", secrets)).toBeNull();
    expect(verifyWebhookSignature(body, null, ENV_IG_SECRET)).toBe(false);
  });

  it("rejects a signature made with a secret we do not hold", () => {
    expect(matchWebhookSecret(body, sign(body, "attacker-app-secret"), secrets)).toBeNull();
  });

  it("rejects a tampered body (one byte changed, signature untouched)", () => {
    const signature = sign(body, ENV_IG_SECRET);
    const tampered = body.replace('"instagram"', '"instagr4m"');
    expect(tampered).not.toBe(body);
    expect(tampered.length).toBe(body.length);
    expect(matchWebhookSecret(tampered, signature, secrets)).toBeNull();
  });

  it("rejects everything when no secret is configured — an empty list is not a wildcard", () => {
    expect(matchWebhookSecret(body, sign(body, ENV_IG_SECRET), [])).toBeNull();
    expect(matchWebhookSecret(body, sign(body, ""), [])).toBeNull();
  });

  it("rejects a header that is not sha256=<hex>, including a bare hex digest", () => {
    const bare = createHmac("sha256", ENV_IG_SECRET).update(body).digest("hex");
    expect(verifyWebhookSignature(body, bare, ENV_IG_SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, `sha1=${bare}`, ENV_IG_SECRET)).toBe(false);
    expect(verifyWebhookSignature(body, "sha256=", ENV_IG_SECRET)).toBe(false);
  });

  it("a truncated signature is refused, not compared as a prefix", () => {
    const full = sign(body, ENV_IG_SECRET);
    expect(verifyWebhookSignature(body, full.slice(0, full.length - 2), ENV_IG_SECRET)).toBe(false);
  });

  it("verifies a Buffer body byte-for-byte, exactly as the raw request arrives", () => {
    const raw = Buffer.from(body, "utf8");
    expect(verifyWebhookSignature(raw, sign(body, ENV_IG_SECRET), ENV_IG_SECRET)).toBe(true);
  });
});

describe("webhook route intake gaps", () => {
  const URL = "http://localhost:3000/api/webhooks/instagram";
  const dm = JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: "17841400000000000",
        time: 1700000000000,
        messaging: [{ sender: { id: "u1" }, recipient: { id: "17841400000000000" }, message: { mid: "mid.q1", text: "salom" } }],
      },
    ],
  });

  function post(body: string, signature?: string) {
    const headers = new Headers({ "content-type": "application/json" });
    if (signature) headers.set("x-hub-signature-256", signature);
    return new NextRequest(URL, { method: "POST", headers, body });
  }

  it("answers 503, not 200, when NEITHER app secret is configured", async () => {
    const ig = process.env.META_INSTAGRAM_APP_SECRET;
    const fb = process.env.META_APP_SECRET;
    delete process.env.META_INSTAGRAM_APP_SECRET;
    delete process.env.META_APP_SECRET;
    try {
      const res = await WEBHOOK_POST(post(dm, sign(dm, ENV_IG_SECRET)));
      expect(res.status).toBe(503);
      expect(store.webhookEvent).toHaveLength(0);
      expect(queueMock.enqueue).not.toHaveBeenCalled();
    } finally {
      process.env.META_INSTAGRAM_APP_SECRET = ig;
      process.env.META_APP_SECRET = fb;
    }
  });

  it("stores a genuine delivery once and enqueues it for processing", async () => {
    const res = await WEBHOOK_POST(post(dm, sign(dm, ENV_IG_SECRET)));
    expect(res.status).toBe(200);
    expect(store.webhookEvent).toHaveLength(1);
    expect(String(store.webhookEvent[0]!.dedupeKey).startsWith("ev:")).toBe(true);
    expect(queueMock.enqueue).toHaveBeenCalledTimes(1);
  });

  it("rejects a valid-looking body whose signature came from another app, before storing anything", async () => {
    const res = await WEBHOOK_POST(post(dm, sign(dm, "another-app")));
    expect(res.status).toBe(401);
    expect(store.webhookEvent).toHaveLength(0);
  });

  it("refuses a correctly signed body that is not JSON", async () => {
    const junk = "not json at all";
    const res = await WEBHOOK_POST(post(junk, sign(junk, ENV_IG_SECRET)));
    expect(res.status).toBe(400);
    expect(store.webhookEvent).toHaveLength(0);
  });
});

/* ================================================================== *
 * 2. Delivery dedupe key
 * ================================================================== */

describe("hashed delivery dedupe key", () => {
  function batch(count: number, seed = 0): WebhookPayload {
    return {
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          time: 1700000000,
          changes: Array.from({ length: count }, (_, i) => ({
            field: "comments",
            value: { id: `1798765432100000${String(seed * 1000 + i).padStart(5, "0")}`, text: "narx?" },
          })),
        },
      ],
    };
  }
  const keyFor = (p: WebhookPayload) => dedupeKeyForDelivery(parseWebhookPayload(p), JSON.stringify(p));

  it("is identical for a redelivery of the very same batch", () => {
    expect(keyFor(batch(5))).toBe(keyFor(batch(5)));
    expect(keyFor(batch(200))).toBe(keyFor(batch(200)));
  });

  it("differs for different batches, including one that is a prefix of the other", () => {
    expect(keyFor(batch(5))).not.toBe(keyFor(batch(5, 1)));
    expect(keyFor(batch(40))).not.toBe(keyFor(batch(41)));
  });

  it("is a fixed length for 1 and for 200 events", () => {
    expect(keyFor(batch(1))).toHaveLength(3 + 64);
    expect(keyFor(batch(200))).toHaveLength(3 + 64);
    expect(parseWebhookPayload(batch(200))).toHaveLength(200);
  });

  it("stays in its own namespace so a per-event marker row cannot shadow a delivery", () => {
    const single = batch(1);
    const evKey = dedupeKeyForEvent(parseWebhookPayload(single)[0]!);
    expect(evKey.startsWith("cmt:")).toBe(true);
    expect(keyFor(single)).not.toBe(evKey);
    expect(keyFor(single).startsWith("ev:")).toBe(true);
  });

  it("falls back to a hash of the raw body when a delivery carries no events", () => {
    expect(dedupeKeyForDelivery([], "{}").startsWith("raw:")).toBe(true);
    expect(dedupeKeyForDelivery([], "{}")).not.toBe(dedupeKeyForDelivery([], "{ }"));
  });

  it("keys a message on its mid, and a mid-less message on its content", () => {
    const withMid = parseWebhookPayload({
      object: "instagram",
      entry: [{ id: "e", time: 1, messaging: [{ sender: { id: "u" }, message: { mid: "m-7", text: "hi" } }] }],
    })[0]!;
    const noMid = parseWebhookPayload({
      object: "instagram",
      entry: [{ id: "e", time: 1, messaging: [{ sender: { id: "u" }, timestamp: 1700000000000, message: { text: "hi" } }] }],
    })[0]!;
    expect(dedupeKeyForEvent(withMid)).toBe("msg:m-7");
    expect(dedupeKeyForEvent(noMid)).toMatch(/^msg:[0-9a-f]{64}$/);
  });
});

/* ================================================================== *
 * 3. Event normalisation (incl. seconds-vs-milliseconds)
 * ================================================================== */

describe("webhook event normalisation", () => {
  const MS_2023 = 1700000000000;
  const SEC_2023 = 1700000000;

  it("normalises a DM, keeping the millisecond timestamp Meta sends", () => {
    const events = parseWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: "acct",
          time: SEC_2023,
          messaging: [
            {
              sender: { id: "cust" },
              recipient: { id: "acct" },
              timestamp: MS_2023,
              message: { mid: "m1", text: "Narx qancha?", quick_reply: { payload: "lf_opt:2" }, attachments: [{ type: "image" }] },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.type).toBe("message");
    if (ev.type !== "message") throw new Error("unreachable");
    expect(ev.senderIgsid).toBe("cust");
    expect(ev.recipientId).toBe("acct");
    expect(ev.text).toBe("Narx qancha?");
    expect(ev.quickReplyPayload).toBe("lf_opt:2");
    expect(ev.attachments).toEqual([{ type: "image" }]);
    expect(ev.isEcho).toBe(false);
    expect(ev.timestamp).toBe(MS_2023);
  });

  it("flags an echo (our own outbound message coming back)", () => {
    const [ev] = parseWebhookPayload({
      object: "instagram",
      entry: [{ id: "acct", time: SEC_2023, messaging: [{ sender: { id: "acct" }, message: { mid: "m2", is_echo: true } }] }],
    });
    expect(ev!.type).toBe("message");
    if (ev!.type === "message") expect(ev!.isEcho).toBe(true);
  });

  it("normalises a postback (button tap) with its payload and title", () => {
    const [ev] = parseWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: "acct",
          time: SEC_2023,
          messaging: [{ sender: { id: "cust" }, timestamp: MS_2023, postback: { mid: "p1", payload: "lf_opt:0", title: "Ha" } }],
        },
      ],
    });
    expect(ev!.type).toBe("postback");
    if (ev!.type !== "postback") throw new Error("unreachable");
    expect(ev!.payload).toBe("lf_opt:0");
    expect(ev!.title).toBe("Ha");
    expect(ev!.timestamp).toBe(MS_2023);
    expect(dedupeKeyForEvent(ev!)).toBe("pb:p1");
  });

  it("normalises a comment and converts created_time SECONDS into milliseconds", () => {
    const [ev] = parseWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: "acct",
          time: SEC_2023,
          changes: [
            {
              field: "comments",
              value: { id: "c1", media: { id: "med1" }, text: "narx?", from: { id: "u9", username: "buyer" }, created_time: SEC_2023 },
            },
          ],
        },
      ],
    });
    expect(ev!.type).toBe("comment");
    if (ev!.type !== "comment") throw new Error("unreachable");
    expect(ev!.commentId).toBe("c1");
    expect(ev!.mediaId).toBe("med1");
    expect(ev!.fromId).toBe("u9");
    expect(ev!.fromUsername).toBe("buyer");
    expect(ev!.timestamp).toBe(MS_2023);
    expect(new Date(ev!.timestamp).getUTCFullYear()).toBe(2023);
  });

  it("normalises a leadgen change", () => {
    const [ev] = parseWebhookPayload({
      object: "page",
      entry: [{ id: "page1", time: SEC_2023, changes: [{ field: "leadgen", value: { leadgen_id: "L1", form_id: "F1" } }] }],
    });
    expect(ev!.type).toBe("leadgen");
    if (ev!.type !== "leadgen") throw new Error("unreachable");
    expect(ev!.leadgenId).toBe("L1");
    expect(ev!.formId).toBe("F1");
    expect(ev!.entryId).toBe("page1");
    expect(dedupeKeyForEvent(ev!)).toBe("lead:L1");
  });

  it("classifies reads, reactions and unknown change fields as 'other'", () => {
    const events = parseWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: "acct",
          time: SEC_2023,
          messaging: [{ sender: { id: "u" }, read: { mid: "x" } }, { sender: { id: "u" }, reaction: { emoji: "love" } }],
          changes: [{ field: "mentions", value: { id: "z" } }],
        },
      ],
    });
    expect(events.map((e) => e.type)).toEqual(["other", "other", "other"]);
    const fields = events.map((e) => (e.type === "other" ? e.field : null));
    expect(fields).toEqual(["read", "reaction", "mentions"]);
  });

  /**
   * THE defect this section exists for. Meta mixes units: messaging timestamps
   * are milliseconds, `entry.time` and `created_time` are seconds. The
   * normalised `timestamp` feeds `new Date(ev.timestamp)` in the queue handler,
   * which becomes Conversation.lastUserMessageAt — the 24-hour messaging
   * window's only anchor. A seconds value there lands in January 1970, which
   * closes the window on a customer who just messaged and makes every automated
   * reply fail with "outside the 24-hour messaging window".
   */
  it("expresses EVERY normalised timestamp in milliseconds, whichever field it came from", () => {
    const events = parseWebhookPayload({
      object: "instagram",
      entry: [
        {
          id: "acct",
          time: SEC_2023, // seconds, per Meta
          messaging: [{ sender: { id: "cust" }, recipient: { id: "acct" }, message: { mid: "m9", text: "salom" } }], // no timestamp
          changes: [{ field: "comments", value: { id: "c9", text: "narx?" } }], // no created_time
        },
      ],
    });
    for (const ev of events) {
      expect(new Date(ev.timestamp).getUTCFullYear()).toBe(2023);
      expect(ev.timestamp).toBe(MS_2023);
    }
  });

  it("a fallback timestamp is usable as a 24h-window anchor, not a 1970 date", () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const [ev] = parseWebhookPayload({
      object: "instagram",
      entry: [{ id: "acct", time: nowSec, messaging: [{ sender: { id: "cust" }, message: { mid: "m10", text: "hi" } }] }],
    });
    expect(isWithinMessagingWindow(new Date(ev!.timestamp))).toBe(true);
  });

  it("defaults to now when the entry carries no time at all", () => {
    const before = Date.now();
    const [ev] = parseWebhookPayload({
      object: "instagram",
      entry: [{ id: "acct", messaging: [{ sender: { id: "cust" }, message: { mid: "m11" } }] }],
    });
    expect(ev!.timestamp).toBeGreaterThanOrEqual(before);
    expect(ev!.timestamp).toBeLessThanOrEqual(Date.now());
  });

  it("returns nothing for an empty payload and survives missing sub-objects", () => {
    expect(parseWebhookPayload({})).toEqual([]);
    expect(parseWebhookPayload({ object: "instagram", entry: [] })).toEqual([]);
    const [ev] = parseWebhookPayload({ object: "instagram", entry: [{ messaging: [{ message: { text: "x" } }] }] });
    expect(ev!.type).toBe("message");
    if (ev!.type === "message") {
      expect(ev!.senderIgsid).toBe("");
      expect(ev!.entryId).toBe("");
      expect(ev!.mid).toBeNull();
    }
  });
});

/* ================================================================== *
 * 4. The 24-hour messaging window
 * ================================================================== */

describe("24-hour messaging window", () => {
  it("is open inside the window and closed at the boundary itself", () => {
    const now = Date.now();
    expect(isWithinMessagingWindow(new Date(now - 1))).toBe(true);
    expect(isWithinMessagingWindow(new Date(now - (MESSAGING_WINDOW_MS - 1000)))).toBe(true);
    // exactly 24h is NOT inside — Meta measures the same boundary and would reject.
    expect(isWithinMessagingWindow(new Date(now - MESSAGING_WINDOW_MS))).toBe(false);
    expect(isWithinMessagingWindow(new Date(now - MESSAGING_WINDOW_MS - 1))).toBe(false);
  });

  it("is closed when the customer has never messaged", () => {
    expect(isWithinMessagingWindow(null)).toBe(false);
    expect(isWithinMessagingWindow(undefined)).toBe(false);
  });

  it("uses exactly 24 hours", () => {
    expect(MESSAGING_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("sendInstagramText enforces the window before Meta is called", () => {
  const account = (over: Partial<InstagramAccount> = {}) =>
    ({ id: "acc_1", igUserId: "ig_1", connectionMode: "INSTAGRAM_LOGIN", isDemo: false, ...over }) as unknown as InstagramAccount;

  it("refuses an automated send outside the window without any network call", async () => {
    await expect(
      sendInstagramText(account(), "cust", "salom", { lastUserMessageAt: new Date(Date.now() - MESSAGING_WINDOW_MS - 1) }),
    ).rejects.toMatchObject({ code: "META_UNSUPPORTED" });
    expect(graphMock).not.toHaveBeenCalled();
  });

  it("refuses when the customer never messaged", async () => {
    await expect(sendInstagramText(account(), "cust", "salom", { lastUserMessageAt: null })).rejects.toThrow(/24-hour/);
    expect(graphMock).not.toHaveBeenCalled();
  });

  it("sends inside the window as messaging_type RESPONSE, on the account's own messages edge", async () => {
    await sendInstagramText(account(), "cust", "salom", { lastUserMessageAt: new Date(Date.now() - 60_000) });
    expect(graphMock).toHaveBeenCalledTimes(1);
    const call = graphMock.mock.calls[0]![0]!;
    expect(call.path).toBe("ig_1/messages");
    expect(call.method).toBe("POST");
    expect(call.body).toMatchObject({ recipient: { id: "cust" }, messaging_type: "RESPONSE", message: { text: "salom" } });
    expect(call.body!.tag).toBeUndefined();
  });

  it("uses me/messages for a Facebook-Login connection", async () => {
    await sendInstagramText(account({ connectionMode: "FACEBOOK_LOGIN" }), "cust", "hi", {
      lastUserMessageAt: new Date(Date.now() - 60_000),
    });
    expect(graphMock.mock.calls[0]![0]!.path).toBe("me/messages");
  });

  it("lets a human agent send outside the window, tagged HUMAN_AGENT", async () => {
    await sendInstagramText(account(), "cust", "javob", { lastUserMessageAt: null, humanAgentTag: true });
    expect(graphMock).toHaveBeenCalledTimes(1);
    expect(graphMock.mock.calls[0]![0]!.body).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
  });

  it("clamps the text to Meta's 1000-byte limit before sending", async () => {
    const original = "ў".repeat(900); // 1800 bytes
    await sendInstagramText(account(), "cust", original, { lastUserMessageAt: new Date() });
    const text = (graphMock.mock.calls[0]![0]!.body as GraphBody).message!.text!;
    const bytes = new TextEncoder().encode(text).length;
    expect(bytes).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    // An upper bound alone is satisfied by a clamp that throws the message away:
    // "…" is 3 bytes and under every limit. The clamp must FILL the budget.
    expect(bytes).toBeGreaterThan(MAX_TEXT_BYTES - 4);
    expect(text.endsWith("…")).toBe(true);
    // and what survives must be the START of what the admin wrote, unaltered.
    expect(original.startsWith(text.slice(0, -1))).toBe(true);
  });

  it("clamps quick replies to 13 buttons of 20 characters", async () => {
    const asked = Array.from({ length: 20 }, (_, i) => ({ title: `Juda uzun variant nomi ${i}`, payload: `p${i}` }));
    await sendInstagramText(account(), "cust", "tanlang", { lastUserMessageAt: new Date(), quickReplies: asked });
    const qrs = (graphMock.mock.calls[0]![0]!.body as GraphBody).message!.quick_replies!;
    expect(qrs).toHaveLength(MAX_QUICK_REPLIES);
    qrs.forEach((qr, i) => {
      expect(qr.content_type).toBe("text");
      // The FIRST 13 in the order the flow offered them — not an arbitrary 13,
      // and not empty titles, both of which a bare length check would accept.
      expect(qr.title).toBe(asked[i]!.title.slice(0, MAX_QUICK_REPLY_TITLE));
      expect(qr.title!.length).toBe(MAX_QUICK_REPLY_TITLE);
      // the payload is what maps the tap back to an option — it must survive whole
      expect(qr.payload).toBe(`p${i}`);
    });
  });

  it("a demo account never reaches Meta at all", async () => {
    const res = await sendInstagramText(account({ isDemo: true }), "cust", "salom", { lastUserMessageAt: new Date() });
    expect(res.messageId).toMatch(/^demo-/);
    expect(graphMock).not.toHaveBeenCalled();
  });

  it("clampTextBytes never splits a multi-byte character", () => {
    const out = clampTextBytes("ў".repeat(900));
    const bytes = new TextEncoder().encode(out);
    expect(bytes.length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(out);
  });
});

/* ================================================================== *
 * 5. OAuth state
 * ================================================================== */

describe("OAuth state signing and verification", () => {
  it("round-trips every field the callback depends on", () => {
    const state = buildState({ mode: "FACEBOOK_LOGIN", adminId: "admin_1", nonce: "n1", accountId: "acc_9", inviteId: "inv_3" });
    const payload = verifyState(state);
    expect(payload).toMatchObject({
      mode: "FACEBOOK_LOGIN",
      adminId: "admin_1",
      nonce: "n1",
      accountId: "acc_9",
      inviteId: "inv_3",
    });
    expect(typeof payload.ts).toBe("number");
  });

  it("rejects a tampered payload — the admin cannot be swapped", () => {
    const state = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "admin_1", nonce: "n1" });
    const [body, sig] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), adminId: "attacker" }),
    ).toString("base64url");
    expect(() => verifyState(`${forged}.${sig}`)).toThrow(/state/i);
  });

  it("rejects a state signed with a different key, and a home-made one", () => {
    const body = Buffer.from(JSON.stringify({ mode: "INSTAGRAM_LOGIN", adminId: "x", nonce: "n", ts: Date.now() })).toString(
      "base64url",
    );
    const foreign = createHmac("sha256", "not-the-session-secret").update(body).digest("base64url");
    expect(() => verifyState(`${body}.${foreign}`)).toThrow(/state/i);
    expect(() => verifyState(`${body}.`)).toThrow();
    expect(() => verifyState(body)).toThrow();
    expect(() => verifyState("")).toThrow();
    expect(() => verifyState("....")).toThrow();
  });

  /**
   * safeEqual() length-checks before timingSafeEqual, which THROWS on unequal
   * buffer lengths. A truncated signature must therefore come back as a clean
   * rejection, not a 500 from the callback route.
   */
  it("a signature of the wrong length is rejected cleanly by the constant-time compare", () => {
    const state = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "a", nonce: "n" });
    const [body, sig] = state.split(".");
    for (const broken of [sig!.slice(0, 5), sig!.slice(0, sig!.length - 1), `${sig}extra`, "x"]) {
      expect(() => verifyState(`${body}.${broken}`)).toThrowError(/state validation failed/i);
    }
  });

  it("expires 15 minutes after it was issued, and not a moment before", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-01T10:00:00Z"));
      const state = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "a", nonce: "n" });

      vi.setSystemTime(new Date("2026-05-01T10:14:59Z"));
      expect(verifyState(state).adminId).toBe("a");

      vi.setSystemTime(new Date("2026-05-01T10:15:00Z")); // exactly 15 min — still valid
      expect(verifyState(state).adminId).toBe("a");

      vi.setSystemTime(new Date("2026-05-01T10:15:01Z"));
      expect(() => verifyState(state)).toThrowError(/expired/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("two states issued back to back differ, so one cannot be replayed as another", () => {
    const a = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "admin_1", nonce: "n1" });
    const b = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "admin_1", nonce: "n2" });
    expect(a).not.toBe(b);
    expect(verifyState(a).nonce).toBe("n1");
    expect(verifyState(b).nonce).toBe("n2");
  });
});

/* ================================================================== *
 * 6. Capability detection
 * ================================================================== */

describe("capability detection", () => {
  const DAY = 24 * 3600 * 1000;

  function token(
    kind: "user" | "page" | "ads",
    scopes: string[],
    over: { expiresAt?: Date | null; status?: string; issuedAt?: Date } = {},
  ) {
    return {
      id: `t_${kind}_${scopes.length}_${over.issuedAt?.getTime() ?? 0}`,
      accountId: "a1",
      kind,
      encrypted: "x",
      status: over.status ?? "ACTIVE",
      scopes,
      issuedAt: over.issuedAt ?? new Date(),
      expiresAt: over.expiresAt ?? null,
      lastRefreshAt: null,
      lastCheckedAt: null,
    } as AccountWithAuth["tokens"][number];
  }

  function permission(name: string, granted: boolean) {
    return { id: `p_${name}`, accountId: "a1", permission: name, granted, checkedAt: new Date() } as AccountWithAuth["permissions"][number];
  }

  function account(over: Partial<AccountWithAuth>): AccountWithAuth {
    return {
      id: "a1",
      igUserId: "178",
      username: "biz",
      connectionMode: "INSTAGRAM_LOGIN",
      fbPageId: null,
      adAccountId: null,
      status: "CONNECTED",
      webhookSubscribed: true,
      isDemo: false,
      permissions: [],
      tokens: [],
      ...over,
    } as AccountWithAuth;
  }

  const IG_ALL = [
    "instagram_business_basic",
    "instagram_business_manage_messages",
    "instagram_business_manage_comments",
    "instagram_business_content_publish",
    "instagram_business_manage_insights",
  ];

  it("Instagram Login with a live user token lights every organic capability", () => {
    const caps = capabilityMap(detectCapabilities(account({ tokens: [token("user", IG_ALL)] })));
    expect([caps.messaging.available, caps.publishing.available, caps.comments.available, caps.insights.available]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(caps.webhooks.available).toBe(true);
  });

  it("names EACH missing organic scope individually", () => {
    for (const missing of [
      ["messaging", "instagram_business_manage_messages"],
      ["publishing", "instagram_business_content_publish"],
      ["comments", "instagram_business_manage_comments"],
      ["insights", "instagram_business_manage_insights"],
    ] as const) {
      const scopes = IG_ALL.filter((s) => s !== missing[1]);
      const caps = capabilityMap(detectCapabilities(account({ tokens: [token("user", scopes)] })));
      expect(caps[missing[0]].available, `${missing[0]} without ${missing[1]}`).toBe(false);
      expect(caps[missing[0]].reason).toMatch(/permission/i);
      // the others keep working — one missing scope must not black out the page
      expect(caps.messaging.available || missing[0] === "messaging").toBe(true);
    }
  });

  it("an INSTAGRAM_LOGIN account with only a page token has no live token at all", () => {
    const caps = capabilityMap(detectCapabilities(account({ tokens: [token("page", IG_ALL)] })));
    expect(caps.messaging.available).toBe(false);
    expect(caps.messaging.reason).toMatch(/expired or revoked/i);
  });

  it("a FACEBOOK_LOGIN account needs the PAGE token, not just a user token", () => {
    const userOnly = capabilityMap(
      detectCapabilities(account({ connectionMode: "FACEBOOK_LOGIN", tokens: [token("user", ["instagram_manage_messages"])] })),
    );
    expect(userOnly.messaging.available).toBe(false);
    expect(userOnly.messaging.reason).toMatch(/expired or revoked/i);

    const withPage = capabilityMap(
      detectCapabilities(
        account({
          connectionMode: "FACEBOOK_LOGIN",
          tokens: [token("user", ["instagram_manage_messages"]), token("page", ["instagram_manage_messages"])],
        }),
      ),
    );
    expect(withPage.messaging.available).toBe(true);
  });

  it("an expired token counts as no token even while its row still says ACTIVE", () => {
    const caps = capabilityMap(detectCapabilities(account({ tokens: [token("user", IG_ALL, { expiresAt: new Date(Date.now() - 1000) })] })));
    expect(caps.messaging.available).toBe(false);
    expect(caps.publishing.available).toBe(false);
    expect(caps.messaging.reason).toMatch(/expired or revoked/i);
  });

  /**
   * A permission row is Meta's own answer at the last authorization; a token's
   * `scopes` is only the snapshot taken when that token was issued. A scope the
   * user has since REVOKED must not keep the feature lit up on the strength of
   * a stale token row — the loss would otherwise surface as a Graph error
   * mid-send.
   */
  it("an explicitly revoked permission outranks a stale token scope list", () => {
    const caps = capabilityMap(
      detectCapabilities(
        account({
          tokens: [token("user", IG_ALL)],
          permissions: [permission("instagram_business_manage_messages", false)],
        }),
      ),
    );
    expect(caps.messaging.available).toBe(false);
    expect(caps.messaging.reason).toMatch(/not granted/i);
    expect(caps.comments.available).toBe(true); // only the revoked one goes dark
  });

  it("a granted permission row alone is enough, even if the token's scope list is empty", () => {
    const caps = capabilityMap(
      detectCapabilities(
        account({ tokens: [token("user", [])], permissions: [permission("instagram_business_manage_messages", true)] }),
      ),
    );
    expect(caps.messaging.available).toBe(true);
  });

  it("ads stays off until token, scope AND ad account are all present — with a different reason for each", () => {
    const nothing = capabilityMap(detectCapabilities(account({ tokens: [token("user", IG_ALL)] })));
    expect(nothing.ads.available).toBe(false);
    expect(nothing.ads.reason).toMatch(/Connect with Facebook \(ads\)/);

    const noAdAccount = capabilityMap(
      detectCapabilities(account({ tokens: [token("user", IG_ALL), token("ads", ["ads_management"])] })),
    );
    expect(noAdAccount.ads.available).toBe(false);
    expect(noAdAccount.ads.reason).toMatch(/No ad account is linked/);

    const complete = capabilityMap(
      detectCapabilities(
        account({ adAccountId: "act_1", tokens: [token("user", IG_ALL), token("ads", ["ads_management"])] }),
      ),
    );
    expect(complete.ads.available).toBe(true);
    expect(complete.ads.reason).toBeUndefined();
  });

  it("lead forms need the ads token, both lead scopes AND a linked Page", () => {
    const base = { adAccountId: "act_1", tokens: [token("user", IG_ALL), token("ads", ["ads_management", "leads_retrieval", "pages_manage_ads"])] };
    const noPage = capabilityMap(detectCapabilities(account({ ...base, fbPageId: null })));
    expect(noPage.lead_forms.available).toBe(false);
    expect(noPage.lead_forms.reason).toMatch(/Page/);

    const missingScope = capabilityMap(
      detectCapabilities(
        account({ ...base, fbPageId: "p1", tokens: [token("user", IG_ALL), token("ads", ["ads_management", "leads_retrieval"])] }),
      ),
    );
    expect(missingScope.lead_forms.available).toBe(false);
    expect(missingScope.lead_forms.reason).toMatch(/lead permissions/i);

    const ok = capabilityMap(detectCapabilities(account({ ...base, fbPageId: "p1" })));
    expect(ok.lead_forms.available).toBe(true);
  });

  /**
   * Meta has no refresh grant for the Facebook token: it dies ~60 days after the
   * authorization and only a reconnect brings advertising back. The deadline has
   * to be surfaced WHILE campaigns still run.
   */
  it("warns, with a date, when the ads token expires inside 10 days", () => {
    const expiresAt = new Date(Date.now() + 5 * DAY);
    const caps = capabilityMap(
      detectCapabilities(
        account({
          adAccountId: "act_1",
          fbPageId: "p1",
          tokens: [
            token("user", IG_ALL),
            token("ads", ["ads_management", "leads_retrieval", "pages_manage_ads"], { expiresAt }),
          ],
        }),
      ),
    );
    expect(caps.ads.available).toBe(true);
    expect(caps.ads.warning).toContain(expiresAt.toISOString().slice(0, 10));
    expect(caps.ads.warning).toMatch(/Reconnect Facebook/);
    expect(caps.lead_forms.warning).toBe(caps.ads.warning);
  });

  it("does not nag while the ads token still has more than 10 days", () => {
    const caps = capabilityMap(
      detectCapabilities(
        account({
          adAccountId: "act_1",
          fbPageId: "p1",
          tokens: [
            token("user", IG_ALL),
            token("ads", ["ads_management", "leads_retrieval", "pages_manage_ads"], { expiresAt: new Date(Date.now() + 30 * DAY) }),
          ],
        }),
      ),
    );
    expect(caps.ads.available).toBe(true);
    expect(caps.ads.warning).toBeUndefined();
  });

  it("calls a LAPSED Facebook connection lapsed, not 'never connected'", () => {
    const caps = capabilityMap(
      detectCapabilities(
        account({
          adAccountId: "act_1",
          fbPageId: "p1",
          tokens: [
            token("user", IG_ALL),
            token("ads", ["ads_management", "leads_retrieval", "pages_manage_ads"], { expiresAt: new Date(Date.now() - DAY) }),
          ],
        }),
      ),
    );
    expect(caps.ads.available).toBe(false);
    expect(caps.ads.reason).toMatch(/expired or was revoked/i);
    expect(caps.ads.reason).toMatch(/messaging keeps working/i);
    expect(caps.ads.warning).toBeUndefined(); // no deadline on a feature that is already off
    expect(caps.lead_forms.reason).toBe(caps.ads.reason);
    expect(caps.messaging.available).toBe(true); // the IG side is untouched
  });

  it("a REVOKED ads token row is lapsed too, not merely unconfigured", () => {
    const caps = capabilityMap(
      detectCapabilities(
        account({
          adAccountId: "act_1",
          tokens: [token("user", IG_ALL), token("ads", ["ads_management"], { status: "REVOKED" })],
        }),
      ),
    );
    expect(caps.ads.available).toBe(false);
    expect(caps.ads.reason).toMatch(/expired or was revoked/i);
  });

  it("reads the deadline off the token advertising actually runs on (newest live one)", () => {
    const soon = new Date(Date.now() + 3 * DAY);
    const caps = capabilityMap(
      detectCapabilities(
        account({
          adAccountId: "act_1",
          tokens: [
            token("user", IG_ALL),
            token("ads", ["ads_management"], { expiresAt: new Date(Date.now() - DAY), issuedAt: new Date(Date.now() - 60 * DAY) }),
            token("ads", ["ads_management"], { expiresAt: soon, issuedAt: new Date(Date.now() - DAY) }),
          ],
        }),
      ),
    );
    expect(caps.ads.available).toBe(true);
    expect(caps.ads.warning).toContain(soon.toISOString().slice(0, 10));
  });

  it("webhooks mirror the subscription flag and explain what to check", () => {
    const off = capabilityMap(detectCapabilities(account({ webhookSubscribed: false, tokens: [token("user", IG_ALL)] })));
    expect(off.webhooks.available).toBe(false);
    expect(off.webhooks.reason).toMatch(/webhook/i);
  });
});

/* ================================================================== *
 * 7. Automation engine
 * ================================================================== */

function seedAccount(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row = { id: "acc_1", igUserId: "ig_1", connectionMode: "INSTAGRAM_LOGIN", isDemo: false, status: "CONNECTED", ...over };
  store.instagramAccount.push(row);
  return row;
}

function seedConversation(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row = {
    id: "conv_1",
    accountId: "acc_1",
    igsid: "cust_1",
    username: "buyer",
    lastUserMessageAt: new Date(),
    leadId: null,
    aiEnabled: true,
    status: "OPEN",
    ...over,
  };
  store.conversation.push(row);
  return row;
}

function seedRule(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row = {
    id: `rule_${store.automation.length + 1}`,
    accountId: "acc_1",
    trigger: "COMMENT_RECEIVED",
    enabled: true,
    contentId: null,
    conditions: [],
    actions: [],
    cooldownSec: null,
    runCount: 0,
    lastRunAt: null,
    ...over,
  };
  store.automation.push(row);
  return row;
}

const lastRun = () => store.automationRun[store.automationRun.length - 1];

describe("automation trigger matching", () => {
  beforeEach(() => {
    seedAccount();
    seedConversation();
  });

  const reply = [{ type: "REPLY_COMMENT", params: { text: "rahmat!" } }];

  it("fires only rules of the same trigger, account and enabled state", async () => {
    seedRule({ id: "r_match", actions: reply });
    seedRule({ id: "r_other_trigger", trigger: "MESSAGE_RECEIVED", actions: reply });
    seedRule({ id: "r_other_account", accountId: "acc_2", actions: reply });
    seedRule({ id: "r_disabled", enabled: false, actions: reply });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1", text: "narx" });

    expect(graphMock).toHaveBeenCalledTimes(1);
    expect(store.automationRun.map((r) => r.automationId)).toEqual(["r_match"]);
  });

  it("runs every matching rule, and counts each run on its own rule", async () => {
    seedRule({ id: "r1", actions: reply });
    seedRule({ id: "r2", actions: reply });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1" });

    expect(graphMock).toHaveBeenCalledTimes(2);
    expect(store.automationRun).toHaveLength(2);
    expect(store.automation.map((a) => a.runCount)).toEqual([1, 1]);
    expect(store.automation.every((a) => a.lastRunAt instanceof Date)).toBe(true);
  });

  it("a rule scoped to one post ignores comments on other posts and records nothing", async () => {
    seedRule({ id: "r_scoped", contentId: "post_1", actions: reply });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c", contentId: "post_2" });
    expect(graphMock).not.toHaveBeenCalled();
    expect(store.automationRun).toHaveLength(0);

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c", contentId: "post_1" });
    expect(graphMock).toHaveBeenCalledTimes(1);
  });

  it("never throws, even when the rule list cannot be loaded", async () => {
    const boom = vi
      .spyOn(db.automation as { findMany: () => Promise<unknown> }, "findMany")
      .mockRejectedValueOnce(new Error("db down"));
    await expect(runAutomations("COMMENT_RECEIVED", { accountId: "acc_1" })).resolves.toBeUndefined();
    boom.mockRestore();
  });

  it("records a FAILED run when an action throws, and keeps going", async () => {
    graphMock.mockRejectedValueOnce(new Error("Meta said no"));
    seedRule({ id: "r_fail", actions: [...reply, ...reply] });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1" });

    expect(graphMock).toHaveBeenCalledTimes(2); // the second action still ran
    expect(lastRun()!.status).toBe("FAILED");
    expect(String(lastRun()!.error)).toMatch(/Meta said no/);
  });
});

describe("automation condition evaluation", () => {
  const ctx = {
    accountId: "acc_1",
    text: "Salom! Kurs NARXI qancha? Ro‘yxatdan o‘tmoqchiman",
    source: "instagram_dm",
    leadStatus: "NEW",
    username: "Demo_Buyer",
  };

  it("contains matches a substring case-insensitively, in Latin and Cyrillic", () => {
    expect(conditionMatches({ field: "text", op: "contains", value: "narxi" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "text", op: "contains", value: "NARX" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "text", op: "contains", value: "refund" }, ctx)).toBe(false);
    expect(conditionMatches({ field: "text", op: "contains", value: "ЦЕНА" }, { accountId: "a", text: "Какая цена?" })).toBe(true);
  });

  it("handles Uzbek letters with the ‘ modifier and dotted İ without crashing", () => {
    expect(conditionMatches({ field: "text", op: "contains", value: "ro‘yxatdan" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "text", op: "contains", value: "o‘tmoqchiman" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "text", op: "equals", value: "İSTANBUL" }, { accountId: "a", text: "İstanbul" })).toBe(true);
  });

  it("not_contains, equals and starts_with behave as their names say", () => {
    expect(conditionMatches({ field: "text", op: "not_contains", value: "refund" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "text", op: "not_contains", value: "narx" }, ctx)).toBe(false);
    expect(conditionMatches({ field: "source", op: "equals", value: "INSTAGRAM_DM" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "source", op: "equals", value: "instagram" }, ctx)).toBe(false);
    expect(conditionMatches({ field: "username", op: "starts_with", value: "demo" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "username", op: "starts_with", value: "buyer" }, ctx)).toBe(false);
  });

  it("regex is case-insensitive and an unusable pattern fails CLOSED", () => {
    expect(conditionMatches({ field: "text", op: "regex", value: "narx\\w*" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "text", op: "regex", value: "^salom" }, ctx)).toBe(true);
    expect(conditionMatches({ field: "text", op: "regex", value: "(" }, ctx)).toBe(false);
  });

  it("an absent context field compares as the empty string, never as a crash", () => {
    expect(conditionMatches({ field: "lead_status", op: "contains", value: "new" }, { accountId: "a" })).toBe(false);
    expect(conditionMatches({ field: "lead_status", op: "equals", value: "" }, { accountId: "a" })).toBe(true);
  });

  it("conditions are ANDed: one failing condition stops the rule", async () => {
    seedAccount();
    seedRule({
      id: "r_cond",
      conditions: [
        { field: "text", op: "contains", value: "narx" },
        { field: "username", op: "starts_with", value: "vip_" },
      ],
      actions: [{ type: "REPLY_COMMENT", params: { text: "hi" } }],
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c", text: "narx?", username: "buyer" });
    expect(graphMock).not.toHaveBeenCalled();

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c", text: "narx?", username: "vip_buyer" });
    expect(graphMock).toHaveBeenCalledTimes(1);
  });
});

describe("per-user cooldown", () => {
  beforeEach(() => {
    seedAccount();
  });

  it("is pure and boundary-exact", () => {
    const now = new Date("2026-01-01T12:00:00Z");
    expect(isWithinCooldown(null, new Date(now.getTime() - 1), now)).toBe(false);
    expect(isWithinCooldown(3600, null, now)).toBe(false);
    expect(isWithinCooldown(3600, new Date(now.getTime() - 3_599_999), now)).toBe(true);
    expect(isWithinCooldown(3600, new Date(now.getTime() - 3_600_000), now)).toBe(false);
  });

  it("blocks a repeat from the SAME person and records the skip with a reason", async () => {
    seedRule({ id: "r_cd", cooldownSec: 3600, actions: [{ type: "REPLY_COMMENT", params: { text: "hi" } }] });
    store.automationRun.push({
      id: "prev",
      automationId: "r_cd",
      actorIgsid: "cust_1",
      status: "SUCCESS",
      createdAt: new Date(Date.now() - 60_000),
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c", igsid: "cust_1" });

    expect(graphMock).not.toHaveBeenCalled();
    expect(lastRun()!.status).toBe("SKIPPED");
    expect(String(lastRun()!.error)).toMatch(/cooldown active \(3600s\)/);
  });

  it("does not block a DIFFERENT person", async () => {
    seedRule({ id: "r_cd", cooldownSec: 3600, actions: [{ type: "REPLY_COMMENT", params: { text: "hi" } }] });
    store.automationRun.push({
      id: "prev",
      automationId: "r_cd",
      actorIgsid: "cust_1",
      status: "SUCCESS",
      createdAt: new Date(Date.now() - 60_000),
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c", igsid: "cust_2" });
    expect(graphMock).toHaveBeenCalledTimes(1);
    expect(lastRun()!.status).toBe("SUCCESS");
  });

  it("only a SUCCESSful earlier run counts — a failed one must not mute the rule", async () => {
    seedRule({ id: "r_cd", cooldownSec: 3600, actions: [{ type: "REPLY_COMMENT", params: { text: "hi" } }] });
    store.automationRun.push({
      id: "prev",
      automationId: "r_cd",
      actorIgsid: "cust_1",
      status: "FAILED",
      createdAt: new Date(Date.now() - 60_000),
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c", igsid: "cust_1" });
    expect(graphMock).toHaveBeenCalledTimes(1);
  });

  it("lets the rule fire again once the window has passed", async () => {
    seedRule({ id: "r_cd", cooldownSec: 60, actions: [{ type: "REPLY_COMMENT", params: { text: "hi" } }] });
    store.automationRun.push({
      id: "prev",
      automationId: "r_cd",
      actorIgsid: "cust_1",
      status: "SUCCESS",
      createdAt: new Date(Date.now() - 61_000),
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c", igsid: "cust_1" });
    expect(graphMock).toHaveBeenCalledTimes(1);
  });

  it("one rule's cooldown never mutes another rule for the same person", async () => {
    seedRule({ id: "r_a", cooldownSec: 3600, actions: [{ type: "REPLY_COMMENT", params: { text: "a" } }] });
    seedRule({ id: "r_b", cooldownSec: 3600, actions: [{ type: "REPLY_COMMENT", params: { text: "b" } }] });
    store.automationRun.push({
      id: "prev",
      automationId: "r_a",
      actorIgsid: "cust_1",
      status: "SUCCESS",
      createdAt: new Date(Date.now() - 1000),
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c", igsid: "cust_1" });
    expect(graphMock).toHaveBeenCalledTimes(1);
    expect(store.automationRun.filter((r) => r.status === "SKIPPED").map((r) => r.automationId)).toEqual(["r_a"]);
  });
});

describe("account-wide outbound rate limit", () => {
  beforeEach(() => {
    seedAccount();
    seedAccount({ id: "acc_2", igUserId: "ig_2" });
  });

  const n = LIMITS.AUTOMATION_ACCOUNT.limit;

  it(`stops outbound actions after ${LIMITS.AUTOMATION_ACCOUNT.limit} in the window, and says how long to wait`, async () => {
    seedRule({
      id: "r_flood",
      actions: Array.from({ length: n + 3 }, () => ({ type: "REPLY_COMMENT", params: { text: "hi" } })),
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c" });

    expect(graphMock).toHaveBeenCalledTimes(n);
    expect(lastRun()!.status).toBe("FAILED");
    expect(String(lastRun()!.error)).toMatch(/account automation rate limit \(retry in \d+s\)/);
  });

  it("the ceiling is per account: a second account still has its full budget", async () => {
    seedRule({ id: "r_1", actions: Array.from({ length: n }, () => ({ type: "REPLY_COMMENT", params: { text: "hi" } })) });
    seedRule({ id: "r_2", accountId: "acc_2", actions: [{ type: "REPLY_COMMENT", params: { text: "hi" } }] });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c" });
    expect(graphMock).toHaveBeenCalledTimes(n);

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_2", commentId: "c" });
    expect(graphMock).toHaveBeenCalledTimes(n + 1);
    expect(lastRun()!.status).toBe("SUCCESS");
  });

  it("the budget is shared across every rule on one account", async () => {
    seedRule({ id: "r_a", actions: Array.from({ length: n }, () => ({ type: "REPLY_COMMENT", params: { text: "hi" } })) });
    seedRule({ id: "r_b", actions: [{ type: "REPLY_COMMENT", params: { text: "hi" } }] });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c" });

    expect(graphMock).toHaveBeenCalledTimes(n);
    expect(lastRun()!.automationId).toBe("r_b");
    expect(lastRun()!.status).toBe("FAILED");
  });

  it("non-outbound actions (CRM only) are not charged to the send budget", async () => {
    store.lead.push({ id: "lead_1", accountId: "acc_1", status: "NEW" });
    seedRule({
      id: "r_crm",
      trigger: "LEAD_SUBMITTED",
      actions: Array.from({ length: n + 5 }, () => ({ type: "SET_LEAD_STATUS", params: { status: "CONTACTED" } })),
    });

    await runAutomations("LEAD_SUBMITTED", { accountId: "acc_1", leadId: "lead_1" });

    expect(lastRun()!.status).toBe("SUCCESS");
    expect(store.lead[0]!.status).toBe("CONTACTED");
  });
});

describe("master switch and action wiring", () => {
  beforeEach(() => {
    seedAccount();
    seedConversation();
  });

  it("the master switch blocks outbound actions before the send layer", async () => {
    store.globalSettings[0]!.masterAutomationEnabled = false;
    seedRule({ id: "r", actions: [{ type: "REPLY_COMMENT", params: { text: "hi" } }] });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "c" });

    expect(graphMock).not.toHaveBeenCalled();
    expect(lastRun()!.status).toBe("FAILED");
    expect(String(lastRun()!.error)).toMatch(/master automation switch OFF/);
  });

  it("lead/CRM actions survive the master switch when leadAutomationWhenOff is set", async () => {
    store.globalSettings[0]!.masterAutomationEnabled = false;
    store.globalSettings[0]!.leadAutomationWhenOff = true;
    store.lead.push({ id: "lead_1", accountId: "acc_1", status: "NEW" });
    seedRule({ id: "r", trigger: "LEAD_SUBMITTED", actions: [{ type: "SET_LEAD_STATUS", params: { status: "QUALIFIED" } }] });

    await runAutomations("LEAD_SUBMITTED", { accountId: "acc_1", leadId: "lead_1" });

    expect(store.lead[0]!.status).toBe("QUALIFIED");
    expect(lastRun()!.status).toBe("SUCCESS");
  });

  it("and are blocked too when that allowance is off", async () => {
    store.globalSettings[0]!.masterAutomationEnabled = false;
    store.globalSettings[0]!.leadAutomationWhenOff = false;
    store.lead.push({ id: "lead_1", accountId: "acc_1", status: "NEW" });
    seedRule({ id: "r", trigger: "LEAD_SUBMITTED", actions: [{ type: "SET_LEAD_STATUS", params: { status: "QUALIFIED" } }] });

    await runAutomations("LEAD_SUBMITTED", { accountId: "acc_1", leadId: "lead_1" });

    expect(store.lead[0]!.status).toBe("NEW");
    expect(String(lastRun()!.error)).toMatch(/master OFF/);
  });

  it("SEND_MESSAGE goes out through the 24h window and is stored as an outbound message", async () => {
    seedRule({ id: "r", trigger: "MESSAGE_RECEIVED", actions: [{ type: "SEND_MESSAGE", params: { text: "Salom!" } }] });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1", conversationId: "conv_1", igsid: "cust_1" });

    expect(graphMock).toHaveBeenCalledTimes(1);
    expect(store.message).toHaveLength(1);
    expect(store.message[0]).toMatchObject({ conversationId: "conv_1", direction: "OUT", sender: "SYSTEM", text: "Salom!" });
    expect(lastRun()!.status).toBe("SUCCESS");
  });

  it("SEND_MESSAGE outside the window fails the run instead of reaching Meta", async () => {
    store.conversation[0]!.lastUserMessageAt = new Date(Date.now() - MESSAGING_WINDOW_MS - 1000);
    seedRule({ id: "r", trigger: "MESSAGE_RECEIVED", actions: [{ type: "SEND_MESSAGE", params: { text: "Salom!" } }] });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1", conversationId: "conv_1" });

    expect(graphMock).not.toHaveBeenCalled();
    expect(store.message).toHaveLength(0);
    expect(lastRun()!.status).toBe("FAILED");
    expect(String(lastRun()!.error)).toMatch(/24-hour messaging window/);
  });

  it("actions missing their context fail with a named reason rather than silently", async () => {
    seedRule({
      id: "r",
      trigger: "MESSAGE_RECEIVED",
      actions: [
        { type: "SEND_MESSAGE", params: { text: "x" } },
        { type: "REPLY_COMMENT", params: { text: "x" } },
        { type: "SET_LEAD_STATUS", params: { status: "WON" } },
        { type: "NOT_A_REAL_ACTION", params: {} },
      ],
    });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1" });

    const results = lastRun()!.result as Array<{ ok: boolean; error?: string }>;
    expect(results.map((r) => r.ok)).toEqual([false, false, false, false]);
    expect(results.map((r) => r.error)).toEqual([
      "no conversation in context",
      "no comment in context",
      "no lead in context",
      "unknown action type",
    ]);
    expect(lastRun()!.status).toBe("FAILED");
  });

  it("SET_LEAD_STATUS refuses a status outside the CRM enum", async () => {
    store.lead.push({ id: "lead_1", accountId: "acc_1", status: "NEW" });
    seedRule({ id: "r", trigger: "LEAD_SUBMITTED", actions: [{ type: "SET_LEAD_STATUS", params: { status: "DROP TABLE" } }] });

    await runAutomations("LEAD_SUBMITTED", { accountId: "acc_1", leadId: "lead_1" });

    expect(store.lead[0]!.status).toBe("NEW");
    expect(String(lastRun()!.error)).toMatch(/invalid status/);
  });

  it("SET_AI hands the conversation to a human and NOTIFY_ADMIN queues an alert", async () => {
    seedRule({
      id: "r",
      trigger: "MESSAGE_RECEIVED",
      actions: [
        { type: "SET_AI", params: { enabled: false } },
        { type: "NOTIFY_ADMIN", params: { text: "VIP mijoz yozdi" } },
      ],
    });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1", conversationId: "conv_1" });

    expect(store.conversation[0]).toMatchObject({ aiEnabled: false, status: "HUMAN" });
    expect(emailMock.queueAdminAlert).toHaveBeenCalledWith("Automation notification", "VIP mijoz yozdi");
    expect(lastRun()!.status).toBe("SUCCESS");
  });

  it("SEND_COMMENT_RESOURCE sends ONE private reply and reports a caption it could not carry", async () => {
    store.commentResource.push({ id: "res_1", accountId: "acc_1", mimeType: "image/jpeg", externalUrl: null });
    seedRule({
      id: "r",
      actions: [{ type: "SEND_COMMENT_RESOURCE", params: { mode: "template", text: "Narxlar ro‘yxati", resourceId: "res_1" } }],
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1", text: "narx" });

    expect(graphMock).toHaveBeenCalledTimes(1);
    const body = graphMock.mock.calls[0]![0]!.body as Required<GraphBody> & {
      message: Required<NonNullable<GraphBody["message"]>>;
    };
    expect(body.recipient).toEqual({ comment_id: "cmt_1" });
    expect(body.message.attachment.type).toBe("image");
    expect(body.message.text).toBeUndefined();
    expect(lastRun()!.status).toBe("SUCCESS");
    expect(String(lastRun()!.error)).toMatch(/caption not sent/);
  });

  it("a missing resource stops the send instead of posting a bare caption", async () => {
    seedRule({
      id: "r",
      actions: [{ type: "SEND_COMMENT_RESOURCE", params: { mode: "template", text: "narx", resourceId: "gone" } }],
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1" });

    expect(graphMock).not.toHaveBeenCalled();
    expect(String(lastRun()!.error)).toMatch(/resource not found/);
  });
});

/* ================================================================== *
 * 8. Lead flow — the state machine, end to end
 * ================================================================== */

function seedFlow(over: Record<string, unknown> = {}): Record<string, unknown> {
  const row = {
    id: "flow_1",
    accountId: "acc_1",
    name: "Ro‘yxatdan o‘tish",
    enabled: true,
    triggerKeywords: [],
    completionMessage: null,
    ...over,
  };
  store.leadFlow.push(row);
  return row;
}

function seedQuestion(over: Partial<LeadFlowQuestion> & { id: string; order: number }): LeadFlowQuestion {
  const row = {
    flowId: "flow_1",
    title: over.id,
    prompt: `${over.id}?`,
    type: "TEXT",
    required: true,
    options: [],
    mapTo: null,
    validationRegex: null,
    ...over,
  } as unknown as LeadFlowQuestion;
  store.leadFlowQuestion.push(row as unknown as Record<string, unknown>);
  return row;
}

function threeQuestionFlow(): void {
  seedFlow();
  seedQuestion({ id: "q_name", order: 1, title: "Ism", prompt: "Ismingiz?", mapTo: "name" } as never);
  seedQuestion({ id: "q_phone", order: 2, title: "Telefon", prompt: "Telefon raqamingiz?", type: "PHONE", mapTo: "phone" } as never);
  seedQuestion({
    id: "q_city",
    order: 3,
    title: "Shahar",
    prompt: "Qaysi shahardansiz?",
    type: "SINGLE_SELECT",
    options: ["Toshkent", "Samarqand"],
  } as never);
}

const activeSessionRow = () => store.leadFlowSession.find((s) => s.status === "ACTIVE");

describe("lead flow session start", () => {
  beforeEach(() => {
    seedAccount();
    seedConversation();
  });

  it("asks the FIRST question only, and parks the session on it", async () => {
    threeQuestionFlow();
    const outcome = await startFlowSession({ flowId: "flow_1", accountId: "acc_1", conversationId: "conv_1" });

    expect(outcome.sessionStatus).toBe("ACTIVE");
    expect(outcome.messages).toHaveLength(1);
    expect(outcome.messages[0]!.text).toBe("Ismingiz?");
    expect(store.leadFlowSession).toHaveLength(1);
    expect(activeSessionRow()).toMatchObject({ flowId: "flow_1", conversationId: "conv_1", currentQuestionId: "q_name" });
    expect(activeSessionRow()!.askedAt).toBeInstanceOf(Date);
  });

  it("cancels an earlier active session in the same conversation rather than running two", async () => {
    threeQuestionFlow();
    await startFlowSession({ flowId: "flow_1", accountId: "acc_1", conversationId: "conv_1" });
    await startFlowSession({ flowId: "flow_1", accountId: "acc_1", conversationId: "conv_1" });

    expect(store.leadFlowSession).toHaveLength(2);
    expect(store.leadFlowSession.filter((s) => s.status === "ACTIVE")).toHaveLength(1);
    expect(store.leadFlowSession[0]!.status).toBe("CANCELLED");
  });

  it("refuses to start a disabled, empty or unknown flow, and creates no session", async () => {
    seedFlow({ id: "flow_off", enabled: false });
    seedFlow({ id: "flow_empty" });
    for (const flowId of ["flow_off", "flow_empty", "flow_missing"]) {
      const outcome = await startFlowSession({ flowId, accountId: "acc_1", conversationId: "conv_1" });
      expect(outcome).toEqual({ messages: [], sessionStatus: "CANCELLED" });
    }
    expect(store.leadFlowSession).toHaveLength(0);
  });

  it("ignores archived questions when picking the first one", async () => {
    seedFlow();
    seedQuestion({ id: "q_archived", order: 1000, prompt: "Old question?" } as never);
    seedQuestion({ id: "q_live", order: 1, prompt: "Ismingiz?" } as never);

    const outcome = await startFlowSession({ flowId: "flow_1", accountId: "acc_1", conversationId: "conv_1" });
    expect(outcome.messages[0]!.text).toBe("Ismingiz?");
    expect(activeSessionRow()!.currentQuestionId).toBe("q_live");
  });

  it("renders a small SINGLE_SELECT as quick replies with option payloads", async () => {
    seedFlow();
    seedQuestion({ id: "q_city", order: 1, prompt: "Shahar?", type: "SINGLE_SELECT", options: ["Toshkent", "Samarqand"] } as never);

    const outcome = await startFlowSession({ flowId: "flow_1", accountId: "acc_1", conversationId: "conv_1" });
    expect(outcome.messages[0]!.quickReplies).toEqual([
      { title: "Toshkent", payload: `${OPTION_PAYLOAD_PREFIX}0` },
      { title: "Samarqand", payload: `${OPTION_PAYLOAD_PREFIX}1` },
    ]);
  });
});

describe("lead flow answers advance one question at a time", () => {
  beforeEach(async () => {
    seedAccount();
    seedConversation();
    threeQuestionFlow();
    await startFlowSession({ flowId: "flow_1", accountId: "acc_1", conversationId: "conv_1" });
  });

  const session = () => activeSessionRow() as never;

  it("stores the answer and asks the NEXT question, one step per message", async () => {
    const first = await handleFlowAnswer(session(), "Aziz");
    expect(first.sessionStatus).toBe("ACTIVE");
    expect(first.messages).toHaveLength(1);
    expect(first.messages[0]!.text).toBe("Telefon raqamingiz?");
    expect(store.leadAnswer).toHaveLength(1);
    expect(store.leadAnswer[0]).toMatchObject({ questionId: "q_name", value: "Aziz" });
    expect(activeSessionRow()!.currentQuestionId).toBe("q_phone");
  });

  it("re-prompts an invalid answer WITHOUT advancing or storing anything", async () => {
    await handleFlowAnswer(session(), "Aziz");
    const bad = await handleFlowAnswer(session(), "not a phone");

    expect(bad.sessionStatus).toBe("ACTIVE");
    expect(bad.messages[0]!.text).toMatch(/valid phone number/i);
    expect(activeSessionRow()!.currentQuestionId).toBe("q_phone"); // unchanged
    expect(store.leadAnswer.map((a) => a.questionId)).toEqual(["q_name"]); // nothing stored for q_phone
  });

  it("accepts the corrected answer afterwards and moves on", async () => {
    await handleFlowAnswer(session(), "Aziz");
    await handleFlowAnswer(session(), "rubbish");
    const good = await handleFlowAnswer(session(), "+998 90 123-45-67");

    expect(good.messages[0]!.text).toContain("Qaysi shahardansiz?");
    expect(store.leadAnswer.find((a) => a.questionId === "q_phone")!.value).toBe("+998901234567");
    expect(activeSessionRow()!.currentQuestionId).toBe("q_city");
  });

  it("a re-answer of the same question overwrites rather than duplicating", async () => {
    await handleFlowAnswer(session(), "Aziz");
    const s = store.leadFlowSession[0]!;
    s.currentQuestionId = "q_name"; // admin/agent rewound the session
    await handleFlowAnswer(s as never, "Aziza");

    expect(store.leadAnswer.filter((a) => a.questionId === "q_name")).toHaveLength(1);
    expect(store.leadAnswer[0]!.value).toBe("Aziza");
  });

  it("honours a quick-reply payload over whatever text came with it", async () => {
    await handleFlowAnswer(session(), "Aziz");
    await handleFlowAnswer(session(), "+998901234567");
    const done = await handleFlowAnswer(session(), "whatever", `${OPTION_PAYLOAD_PREFIX}1`);

    expect(done.sessionStatus).toBe("COMPLETED");
    expect(store.leadAnswer.find((a) => a.questionId === "q_city")!.value).toBe("Samarqand");
  });

  it("cancels on any cancel keyword, in any case, and stops asking", async () => {
    expect(CANCEL_KEYWORDS).toContain("bekor");
    const out = await handleFlowAnswer(session(), " BEKOR ");
    expect(out.sessionStatus).toBe("CANCELLED");
    expect(out.messages[0]!.text).toMatch(/cancelled/i);
    expect(store.leadFlowSession[0]!.status).toBe("CANCELLED");
    expect(store.lead).toHaveLength(0);
  });

  it("a word merely CONTAINING a cancel keyword is an answer, not a cancellation", async () => {
    const out = await handleFlowAnswer(session(), "Stopa Ivanovna");
    expect(out.sessionStatus).toBe("ACTIVE");
    expect(store.leadAnswer[0]!.value).toBe("Stopa Ivanovna");
  });

  /**
   * An admin can rewrite the flow's questions while someone is mid-answer; the
   * question the session sits on is then archived and no longer in the live
   * list. The session is closed rather than answering with the wrong question.
   */
  it("closes the session when the question it sits on is no longer live", async () => {
    store.leadFlowQuestion.find((q) => q.id === "q_name")!.order = 1000;
    const out = await handleFlowAnswer(session(), "Aziz");
    expect(out.sessionStatus).toBe("CANCELLED");
    expect(store.leadFlowSession[0]!.status).toBe("CANCELLED");
    expect(store.leadAnswer).toHaveLength(0);
  });
});

describe("lead flow completion builds the lead", () => {
  beforeEach(async () => {
    seedAccount();
    seedConversation();
    threeQuestionFlow();
    store.ctaConfig.push({ id: "cta_1", accountId: "acc_1", leadFlowId: "flow_1" });
    await startFlowSession({ flowId: "flow_1", accountId: "acc_1", conversationId: "conv_1" });
  });

  async function answerAll(): Promise<void> {
    await handleFlowAnswer(activeSessionRow() as never, "Aziz");
    await handleFlowAnswer(activeSessionRow() as never, "+998901234567");
    await handleFlowAnswer(activeSessionRow() as never, "1");
  }

  it("creates ONE lead with the mapped fields and every answer in question order", async () => {
    await answerAll();

    expect(store.lead).toHaveLength(1);
    const lead = store.lead[0]!;
    expect(lead).toMatchObject({
      accountId: "acc_1",
      igsid: "cust_1",
      conversationId: "conv_1",
      name: "Aziz",
      phone: "+998901234567",
      email: null,
      source: "instagram_dm",
      flowId: "flow_1",
      status: "NEW",
      ctaConfigId: "cta_1",
    });
    expect(lead.answers).toEqual([
      { question: "Ism", answer: "Aziz" },
      { question: "Telefon", answer: "+998901234567" },
      { question: "Shahar", answer: "Toshkent" },
    ]);
  });

  it("closes the session, links it both ways and records a CREATED event", async () => {
    await answerAll();

    const session = store.leadFlowSession[0]!;
    expect(session.status).toBe("COMPLETED");
    expect(session.leadId).toBe(store.lead[0]!.id);
    expect(session.completedAt).toBeInstanceOf(Date);
    expect(store.conversation[0]!.leadId).toBe(store.lead[0]!.id);
    expect(store.leadEvent).toHaveLength(1);
    expect(store.leadEvent[0]).toMatchObject({ leadId: store.lead[0]!.id, type: "CREATED" });
  });

  it("thanks the customer with the flow's own completion message when it has one", async () => {
    store.leadFlow[0]!.completionMessage = "Rahmat! Tez orada bog‘lanamiz.";
    const last = await (async () => {
      await handleFlowAnswer(activeSessionRow() as never, "Aziz");
      await handleFlowAnswer(activeSessionRow() as never, "+998901234567");
      return handleFlowAnswer(activeSessionRow() as never, "2");
    })();

    expect(last.sessionStatus).toBe("COMPLETED");
    expect(last.messages[0]!.text).toBe("Rahmat! Tez orada bog‘lanamiz.");
    expect(last.completedSessionId).toBe(store.leadFlowSession[0]!.id);
  });

  it("falls back to a default thank-you when the flow has only whitespace", async () => {
    store.leadFlow[0]!.completionMessage = "   ";
    await handleFlowAnswer(activeSessionRow() as never, "Aziz");
    await handleFlowAnswer(activeSessionRow() as never, "+998901234567");
    const last = await handleFlowAnswer(activeSessionRow() as never, "1");

    expect(store.leadFlowSession[0]!.status).toBe("COMPLETED");
    // The customer must actually be thanked. Asserting only "COMPLETED" would
    // pass while the flow answered with "   " or with nothing at all.
    expect(last.messages).toHaveLength(1);
    expect(last.messages[0]!.text.trim().length).toBeGreaterThan(10);
    expect(last.messages[0]!.text).toMatch(/thank you/i);
  });

  /**
   * completeSession() sorts the answers by their QUESTION's order before it
   * builds Lead.answers. Answering 1-2-3 in sequence cannot tell that sort from
   * plain insertion order, so the rows are physically reordered here — a
   * database returns them in no guaranteed order — and the JSON must still read
   * the way the admin designed the form.
   */
  it("orders Lead.answers by the question order, not by the order rows come back in", async () => {
    await answerAll();
    expect(store.lead).toHaveLength(1);
    const inOrder = (store.lead[0]!.answers as Array<{ question: string }>).map((a) => a.question);
    expect(inOrder).toEqual(["Ism", "Telefon", "Shahar"]);

    // same session, answers handed back reversed
    store.lead.length = 0;
    store.leadEvent.length = 0;
    store.leadAnswer.reverse();
    store.leadFlowSession[0]!.status = "ACTIVE";
    const again = store.leadFlowSession[0]!;
    again.currentQuestionId = "q_city";
    await handleFlowAnswer(again as never, "1");

    const reordered = (store.lead[0]!.answers as Array<{ question: string }>).map((a) => a.question);
    expect(reordered).toEqual(["Ism", "Telefon", "Shahar"]);
  });

  it("falls back to the Instagram username when no question maps to a name", async () => {
    store.leadFlowQuestion.find((q) => q.id === "q_name")!.mapTo = null;
    await answerAll();
    expect(store.lead[0]!.name).toBe("buyer");
  });

  it("does not attribute the lead to a Lead Button built on a different flow", async () => {
    store.ctaConfig[0]!.leadFlowId = "some_other_flow";
    await answerAll();
    expect(store.lead[0]!.ctaConfigId).toBeNull();
  });
});

describe("lead flow session expiry", () => {
  beforeEach(async () => {
    seedAccount();
    seedConversation();
    threeQuestionFlow();
    await startFlowSession({ flowId: "flow_1", accountId: "acc_1", conversationId: "conv_1" });
  });

  it("returns the live session while it is inside the 24h window", async () => {
    store.leadFlowSession[0]!.askedAt = new Date(Date.now() - SESSION_EXPIRY_MS + 5000);
    const session = await getActiveSession("conv_1");
    expect(session?.id).toBe(store.leadFlowSession[0]!.id);
    expect(session?.flow.name).toBe("Ro‘yxatdan o‘tish");
  });

  it("expires it once 24h have passed since the last question was asked", async () => {
    store.leadFlowSession[0]!.askedAt = new Date(Date.now() - SESSION_EXPIRY_MS - 1000);
    expect(await getActiveSession("conv_1")).toBeNull();
    expect(store.leadFlowSession[0]!.status).toBe("EXPIRED");
  });

  it("falls back to startedAt when no question has been asked yet", async () => {
    store.leadFlowSession[0]!.askedAt = null;
    store.leadFlowSession[0]!.startedAt = new Date(Date.now() - SESSION_EXPIRY_MS - 1000);
    expect(await getActiveSession("conv_1")).toBeNull();
    expect(store.leadFlowSession[0]!.status).toBe("EXPIRED");
  });

  it("returns null for a conversation with no session at all", async () => {
    expect(await getActiveSession("conv_unknown")).toBeNull();
  });
});

describe("a lead flow must belong to the rule's own account", () => {
  beforeEach(() => {
    seedAccount();
    seedConversation();
    threeQuestionFlow();
  });

  it("refuses another account's flow before any session is created", async () => {
    store.leadFlow[0]!.accountId = "acc_other";
    seedRule({ id: "r", trigger: "MESSAGE_RECEIVED", actions: [{ type: "START_LEAD_FLOW", params: { flowId: "flow_1" } }] });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1", conversationId: "conv_1" });

    expect(store.leadFlowSession).toHaveLength(0);
    expect(graphMock).not.toHaveBeenCalled();
    expect(lastRun()!.status).toBe("FAILED");
    expect(String(lastRun()!.error)).toMatch(/does not belong to this account/);
  });

  it("refuses a flowId that no longer resolves", async () => {
    seedRule({ id: "r", trigger: "MESSAGE_RECEIVED", actions: [{ type: "START_LEAD_FLOW", params: { flowId: "ghost" } }] });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1", conversationId: "conv_1" });

    expect(store.leadFlowSession).toHaveLength(0);
    expect(String(lastRun()!.error)).toMatch(/does not belong to this account/);
  });

  it("starts the account's own flow and DMs the first question", async () => {
    seedRule({ id: "r", trigger: "MESSAGE_RECEIVED", actions: [{ type: "START_LEAD_FLOW", params: { flowId: "flow_1" } }] });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1", conversationId: "conv_1", igsid: "cust_1" });

    expect(store.leadFlowSession).toHaveLength(1);
    expect(graphMock).toHaveBeenCalledTimes(1);
    expect((graphMock.mock.calls[0]![0]!.body as GraphBody).message?.text).toBe("Ismingiz?");
    expect(store.message).toHaveLength(1);
    expect(lastRun()!.status).toBe("SUCCESS");
  });

  it("reports an empty flow as a failed action instead of pretending it started", async () => {
    store.leadFlowQuestion.length = 0;
    seedRule({ id: "r", trigger: "MESSAGE_RECEIVED", actions: [{ type: "START_LEAD_FLOW", params: { flowId: "flow_1" } }] });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1", conversationId: "conv_1" });

    expect(graphMock).not.toHaveBeenCalled();
    expect(String(lastRun()!.error)).toMatch(/flow disabled or empty/);
  });
});

/* ================================================================== *
 * 9. Keyword triggers
 * ================================================================== */

describe("trigger keyword matching", () => {
  it("matches a code word case-insensitively", () => {
    expect(keywordMatches("START", "start")).toBe(true);
    expect(keywordMatches("Start please", "START")).toBe(true);
    expect(keywordMatches("narx qancha", "NARX")).toBe(true);
  });

  it("matches a keyword that carries an Uzbek/Russian suffix", () => {
    expect(keywordMatches("Narxi qancha?", "narx")).toBe(true);
    expect(keywordMatches("Narxlari qancha?", "narx")).toBe(true);
    expect(keywordMatches("Какая цены?", "цен")).toBe(true);
  });

  it("matches at the start, at the end, after punctuation and after a hashtag", () => {
    expect(keywordMatches("start", "start")).toBe(true);
    expect(keywordMatches("men start", "start")).toBe(true);
    expect(keywordMatches("salom, start!", "start")).toBe(true);
    expect(keywordMatches("#start", "start")).toBe(true);
    expect(keywordMatches("(start)", "start")).toBe(true);
  });

  /**
   * A trigger keyword is a CODE WORD, not a substring. Firing a whole automated
   * question flow because "restarted" contains "start" hijacks an ordinary
   * conversation, and the shorter the keyword the worse it gets: "ha" (Uzbek
   * "yes") appears inside "rahmat", "shahar", "muhandis".
   */
  it("does not fire on a keyword buried inside a longer word", () => {
    expect(keywordMatches("I restarted my phone", "start")).toBe(false);
    expect(keywordMatches("rahmat, shahar chiroyli", "ha")).toBe(false);
    expect(keywordMatches("kursga yozildim", "kurs")).toBe(true); // a real word start still matches
  });

  it("still finds a later, properly-bounded occurrence after a buried one", () => {
    expect(keywordMatches("restarted, then start", "start")).toBe(true);
  });

  it("matches multi-word keywords and ignores empty ones", () => {
    expect(keywordMatches("kurs narxi qancha", "kurs narx")).toBe(true);
    expect(keywordMatches("anything", "")).toBe(false);
    expect(keywordMatches("anything", "   ")).toBe(false);
  });

  it("finds the right flow for an account, ignoring disabled flows and other accounts", async () => {
    seedAccount();
    seedFlow({ id: "flow_on", triggerKeywords: ["narx", "price"] });
    seedFlow({ id: "flow_off", enabled: false, triggerKeywords: ["bepul"] });
    seedFlow({ id: "flow_other", accountId: "acc_2", triggerKeywords: ["kurs"] });

    expect(await findFlowByKeyword("acc_1", "Narxi qancha?")).toBe("flow_on");
    expect(await findFlowByKeyword("acc_1", "what is the PRICE")).toBe("flow_on");
    expect(await findFlowByKeyword("acc_1", "bepul dars bormi?")).toBeNull();
    expect(await findFlowByKeyword("acc_1", "kurs haqida")).toBeNull();
    expect(await findFlowByKeyword("acc_1", "salom")).toBeNull();
  });

  it("an empty keyword in the list never turns a flow into a catch-all", async () => {
    seedAccount();
    seedFlow({ id: "flow_bad", triggerKeywords: ["", "  ", "narx"] });
    expect(await findFlowByKeyword("acc_1", "salom, yaxshimisiz?")).toBeNull();
    expect(await findFlowByKeyword("acc_1", "narx?")).toBe("flow_bad");
  });
});

/* ================================================================== *
 * Sanity: the normalised event type really is exhaustive
 * ================================================================== */

describe("normalised event model", () => {
  it("every event kind produces a dedupe key in its own namespace", () => {
    const kinds: NormalizedEvent[] = [
      { type: "message", entryId: "e", senderIgsid: "s", recipientId: "r", mid: "m", text: null, attachments: null, quickReplyPayload: null, isEcho: false, timestamp: 1 },
      { type: "postback", entryId: "e", senderIgsid: "s", mid: "p", payload: "x", title: null, timestamp: 1 },
      { type: "comment", entryId: "e", commentId: "c", mediaId: null, text: null, fromId: null, fromUsername: null, timestamp: 1 },
      { type: "leadgen", entryId: "e", leadgenId: "l", formId: null, timestamp: 1 },
      { type: "other", entryId: "e", field: "read", timestamp: 1 },
    ];
    const prefixes = kinds.map((k) => dedupeKeyForEvent(k).split(":")[0]);
    expect(prefixes).toEqual(["msg", "pb", "cmt", "lead", "oth"]);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

/* ================================================================== *
 * OAuth token exchanges (Mode A + Mode B)
 *
 * Nothing in the repo covered these five functions. They are the only
 * path by which an account ever gets a token, and the ONLY thing between
 * Meta's answer and `new Date(Date.now() + expiresInSec * 1000)` being
 * written to InstagramAccount.expiresAt (src/lib/meta/accounts.ts:45,
 * :164, :441). fetch is stubbed; Meta is never called.
 * ================================================================== */

type FetchCall = { url: string; init?: RequestInit };
type FetchAnswer = { ok?: boolean; status?: number; body: unknown };

/** Stub global fetch with a queue of canned Meta answers; records every call. */
function stubFetch(...answers: FetchAnswer[]) {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    // The last answer repeats, so a retrying caller keeps getting it.
    const a: FetchAnswer = answers[Math.min(i++, answers.length - 1)] ?? { body: {} };
    return {
      ok: a.ok ?? true,
      status: a.status ?? (a.ok === false ? 400 : 200),
      json: async () => a.body,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

/** The form body postForm() sent, decoded back into a plain object. */
function formOf(call: FetchCall): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(call.init?.body ?? "")));
}

describe("Instagram Login token exchange (Mode A)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the code to api.instagram.com with the INSTAGRAM app credentials, never the Facebook ones", async () => {
    const { calls } = stubFetch({ body: { access_token: "short_1", user_id: 17841400000000000 } });
    const out = await igExchangeCode("the-code");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.instagram.com/oauth/access_token");
    expect(calls[0]!.init?.method).toBe("POST");

    const form = formOf(calls[0]!);
    // vitest.config.ts sets these deliberately different so a mix-up is visible.
    expect(form.client_id).toBe("test-ig-app-id");
    expect(form.client_secret).toBe("test-ig-app-secret");
    expect(form.client_id).not.toBe(process.env.META_APP_ID);
    expect(form.client_secret).not.toBe(process.env.META_APP_SECRET);
    expect(form.grant_type).toBe("authorization_code");
    expect(form.code).toBe("the-code");
    expect(form.redirect_uri).toBe(process.env.META_REDIRECT_URI);

    expect(out).toEqual({ accessToken: "short_1", igUserId: "17841400000000000", permissions: [] });
  });

  it("accepts the {data:[{...}]} shape Meta also ships", async () => {
    stubFetch({ body: { data: [{ access_token: "short_2", user_id: "991", permissions: ["a", "b"] }] } });
    await expect(igExchangeCode("c")).resolves.toEqual({
      accessToken: "short_2",
      igUserId: "991",
      permissions: ["a", "b"],
    });
  });

  it("splits a comma-separated permissions string and trims it", async () => {
    stubFetch({ body: { access_token: "t", user_id: 5, permissions: "instagram_business_basic, instagram_business_manage_messages ,," } });
    const out = await igExchangeCode("c");
    expect(out.permissions).toEqual(["instagram_business_basic", "instagram_business_manage_messages"]);
  });

  it("refuses a 200 that carries no access_token instead of returning undefined", async () => {
    stubFetch({ body: { user_id: 5 } });
    await expect(igExchangeCode("c")).rejects.toMatchObject({ code: "META_AUTH_FAILED" });
  });

  it("surfaces Instagram's error_message (api.instagram.com does not use the graph error object)", async () => {
    stubFetch({ ok: false, status: 400, body: { error_type: "OAuthException", code: 400, error_message: "Invalid authorization code" } });
    await expect(igExchangeCode("stale")).rejects.toThrow(/Invalid authorization code/);
  });

  it("exchanges short -> long-lived on graph.instagram.com with ig_exchange_token", async () => {
    const { calls } = stubFetch({ body: { access_token: "long_1", expires_in: 5184000 } });
    const out = await igExchangeLongLived("short_1");

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_exchange_token");
    expect(url.searchParams.get("client_secret")).toBe("test-ig-app-secret");
    expect(url.searchParams.get("access_token")).toBe("short_1");
    expect(out).toEqual({ accessToken: "long_1", expiresInSec: 5184000 });
  });

  it("refreshes a long-lived token WITHOUT sending the app secret", async () => {
    const { calls } = stubFetch({ body: { access_token: "long_2", expires_in: 5184000 } });
    const out = await igRefreshLongLived("long_1");

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://graph.instagram.com/refresh_access_token");
    expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
    // The refresh endpoint authenticates with the token alone; leaking the
    // secret into a query string would put it in Meta's access logs.
    expect(url.searchParams.get("client_secret")).toBeNull();
    expect(out.accessToken).toBe("long_2");
  });

  it("raises Meta's graph error on a failed refresh rather than returning a blank token", async () => {
    stubFetch({ ok: false, status: 400, body: { error: { message: "Session has expired", type: "OAuthException", code: 190 } } });
    // Code 190 is translated into an admin-readable message, but the Meta
    // code must survive so the reconnect path can recognise a dead token.
    await expect(igRefreshLongLived("dead")).rejects.toMatchObject({
      name: "MetaApiError",
      metaCode: 190,
      isTokenError: true,
    });
  });
});

describe("Facebook Login token exchange (Mode B)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the FACEBOOK app credentials and the pinned graph version", async () => {
    const { calls } = stubFetch({ body: { access_token: "fb_short", expires_in: 3600 } });
    const out = await fbExchangeCode("code-b");

    const url = new URL(calls[0]!.url);
    expect(url.origin).toBe("https://graph.facebook.com");
    expect(url.pathname).toBe("/" + process.env.META_GRAPH_VERSION + "/oauth/access_token");
    expect(url.searchParams.get("client_id")).toBe("test-fb-app-id");
    expect(url.searchParams.get("client_secret")).toBe("test-fb-app-secret");
    expect(url.searchParams.get("code")).toBe("code-b");
    expect(out).toEqual({ accessToken: "fb_short", expiresInSec: 3600 });
  });

  it("exchanges the short user token for a long-lived one", async () => {
    const { calls } = stubFetch({ body: { access_token: "fb_long", expires_in: 5184000 } });
    const out = await fbExchangeLongLived("fb_short");

    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("grant_type")).toBe("fb_exchange_token");
    expect(url.searchParams.get("fb_exchange_token")).toBe("fb_short");
    expect(out).toEqual({ accessToken: "fb_long", expiresInSec: 5184000 });
  });

  it("falls back to 60 days when Meta omits expires_in on the long-lived exchange", async () => {
    stubFetch({ body: { access_token: "fb_long" } });
    await expect(fbExchangeLongLived("s")).resolves.toEqual({ accessToken: "fb_long", expiresInSec: 60 * 24 * 3600 });
  });
});

/**
 * A 200 is not by itself a token. Every one of these results is fed straight
 * into `new Date(Date.now() + expiresInSec * 1000)`; an absent access_token or
 * expires_in used to sail through as undefined and land an Invalid Date on the
 * account row — and the nightly refresh (accounts.ts:441) does that for every
 * account it touches.
 */
describe("a 200 with a malformed body never becomes a stored token", () => {
  afterEach(() => vi.unstubAllGlobals());

  const cases: Array<[string, () => Promise<unknown>]> = [
    ["igExchangeLongLived", () => igExchangeLongLived("s")],
    ["igRefreshLongLived", () => igRefreshLongLived("s")],
    ["fbExchangeCode", () => fbExchangeCode("c")],
    ["fbExchangeLongLived", () => fbExchangeLongLived("s")],
  ];

  for (const [name, call] of cases) {
    it(name + " refuses a 200 with no access_token", async () => {
      stubFetch({ body: { expires_in: 5184000 } });
      await expect(call()).rejects.toMatchObject({ code: "META_AUTH_FAILED" });
    });
  }

  it("igExchangeLongLived never yields a NaN expiry when expires_in is missing", async () => {
    stubFetch({ body: { access_token: "long" } });
    const out = await igExchangeLongLived("s");
    expect(Number.isFinite(out.expiresInSec)).toBe(true);
    expect(out.expiresInSec).toBeGreaterThan(0);
    // The value the caller actually computes must be a real date.
    expect(new Date(Date.now() + out.expiresInSec * 1000).getTime()).not.toBeNaN();
  });

  it("a non-numeric expires_in is replaced, not multiplied into NaN", async () => {
    stubFetch({ body: { access_token: "long", expires_in: "soon" } });
    const out = await igRefreshLongLived("s");
    expect(Number.isFinite(out.expiresInSec)).toBe(true);
    expect(new Date(Date.now() + out.expiresInSec * 1000).getTime()).not.toBeNaN();
  });
});

describe("Instagram Login scope list", () => {
  const saved = process.env.META_INSTAGRAM_EXTRA_SCOPES;
  afterEach(() => {
    if (saved === undefined) delete process.env.META_INSTAGRAM_EXTRA_SCOPES;
    else process.env.META_INSTAGRAM_EXTRA_SCOPES = saved;
  });

  it("requests only the three REQUIRED permissions by default", () => {
    delete process.env.META_INSTAGRAM_EXTRA_SCOPES;
    expect(igLoginScopes()).toEqual([
      "instagram_business_basic",
      "instagram_business_manage_messages",
      "instagram_business_manage_comments",
    ]);
  });

  it("merges configured extras, trimming blanks and de-duplicating", () => {
    process.env.META_INSTAGRAM_EXTRA_SCOPES = " instagram_business_content_publish , ,instagram_business_basic ";
    const scopes = igLoginScopes();
    expect(scopes).toContain("instagram_business_content_publish");
    expect(scopes.filter((s) => s === "instagram_business_basic")).toHaveLength(1);
    expect(scopes).not.toContain("");
  });
});

/* ================================================================== *
 * Private reply to a comment
 * ================================================================== */

describe("sendPrivateReplyToComment", () => {
  const account = { id: "acct_1", connectMode: "INSTAGRAM_LOGIN", igUserId: "ig_1", isDemo: false } as unknown as InstagramAccount;

  it("addresses the COMMENT, not the commenter's igsid, and skips the 24h window", async () => {
    // A private reply is allowed for 7 days after the comment even when the
    // person has never DM'd us, so no lastUserMessageAt is involved at all.
    await sendPrivateReplyToComment(account, "cmt_77", "here you go");

    expect(graphMock).toHaveBeenCalledTimes(1);
    const body = graphMock.mock.calls[0]![0]!.body as GraphBody;
    expect(body.recipient).toEqual({ comment_id: "cmt_77" });
    expect(body.recipient?.id).toBeUndefined();
    expect(body.message?.text).toBe("here you go");
    expect(body.messaging_type).toBeUndefined();
  });

  it("clamps an over-long private reply to Meta's byte budget", async () => {
    await sendPrivateReplyToComment(account, "cmt_1", "x".repeat(MAX_TEXT_BYTES + 250));
    const body = graphMock.mock.calls[0]![0]!.body as GraphBody;
    expect(new TextEncoder().encode(body.message?.text ?? "").length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(body.message?.text?.endsWith("…")).toBe(true);
  });
});

/* ================================================================== *
 * AUDIT PASS — paths the first sweep left open.
 *
 * Everything below drives the same product code against the same
 * in-memory Prisma; nothing here asserts a mock against itself.
 * ================================================================== */

describe("[audit] webhook route: redelivery, handshake, misconfiguration", () => {
  const URL = "http://localhost:3000/api/webhooks/instagram";

  function post(body: string, signature?: string) {
    const headers = new Headers({ "content-type": "application/json" });
    if (signature) headers.set("x-hub-signature-256", signature);
    return new NextRequest(URL, { method: "POST", headers, body });
  }

  const delivery = (mids: string[]) =>
    JSON.stringify({
      object: "instagram",
      entry: [
        {
          id: "17841400000000000",
          time: 1700000000,
          messaging: mids.map((mid) => ({
            sender: { id: "u1" },
            recipient: { id: "17841400000000000" },
            message: { mid, text: "salom" },
          })),
        },
      ],
    });

  /**
   * Meta's delivery guarantee is AT LEAST ONCE: an ack that arrives late is a
   * redelivery. The route's whole dedupe branch (the findUnique before the
   * create) is what stops the same DM being answered twice, and no test in this
   * group's file made a second POST at all.
   */
  it("stores and enqueues a redelivered, byte-identical delivery exactly once", async () => {
    const body = delivery(["mid.a", "mid.b"]);
    const sig = sign(body, ENV_IG_SECRET);

    const first = await WEBHOOK_POST(post(body, sig));
    const second = await WEBHOOK_POST(post(body, sig));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(store.webhookEvent).toHaveLength(1);
    expect(queueMock.enqueue).toHaveBeenCalledTimes(1);
  });

  /**
   * The prefix-collision case at the level a customer actually feels it: the
   * second delivery repeats the first delivery's event and adds one more. A key
   * built by truncation would call it a duplicate and the new DM would never be
   * answered.
   */
  it("does not mistake a longer delivery that starts with the same events for a redelivery", async () => {
    const one = delivery(["mid.a"]);
    const two = delivery(["mid.a", "mid.b"]);

    await WEBHOOK_POST(post(one, sign(one, ENV_IG_SECRET)));
    const res = await WEBHOOK_POST(post(two, sign(two, ENV_IG_SECRET)));

    expect(await res.json()).toEqual({ received: true });
    expect(store.webhookEvent).toHaveLength(2);
    expect(new Set(store.webhookEvent.map((e) => e.dedupeKey)).size).toBe(2);
    expect(queueMock.enqueue).toHaveBeenCalledTimes(2);
  });

  it("stores the payload it verified, whichever app signed it", async () => {
    const body = delivery(["mid.z"]);
    await WEBHOOK_POST(post(body, sign(body, ENV_FB_SECRET))); // the OTHER app
    expect(store.webhookEvent).toHaveLength(1);
    expect(store.webhookEvent[0]).toMatchObject({ object: "instagram", signatureValid: true, status: "QUEUED" });
    expect(JSON.parse(JSON.stringify(store.webhookEvent[0]!.payload))).toEqual(JSON.parse(body));
  });

  /**
   * The subscription handshake is the first thing an admin hits when wiring the
   * webhook up in the App Dashboard, and the verify token is a shared secret
   * compared with safeEqual — a prefix must not be accepted.
   */
  it("echoes the challenge for the exact verify token only", async () => {
    const real = process.env.META_WEBHOOK_VERIFY_TOKEN!;
    const ok = await WEBHOOK_GET(
      new NextRequest(`${URL}?hub.mode=subscribe&hub.verify_token=${real}&hub.challenge=echo-me`),
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("echo-me");

    for (const bad of [real.slice(0, real.length - 1), `${real}x`, "", "wrong"]) {
      const res = await WEBHOOK_GET(
        new NextRequest(`${URL}?hub.mode=subscribe&hub.verify_token=${bad}&hub.challenge=echo-me`),
      );
      expect(res.status, `verify_token "${bad}"`).toBe(403);
    }
    const wrongMode = await WEBHOOK_GET(
      new NextRequest(`${URL}?hub.mode=unsubscribe&hub.verify_token=${real}&hub.challenge=echo-me`),
    );
    expect(wrongMode.status).toBe(403);
  });

  it("answers 503, not 403, when the verify token is not configured at all", async () => {
    const saved = process.env.META_WEBHOOK_VERIFY_TOKEN;
    delete process.env.META_WEBHOOK_VERIFY_TOKEN;
    try {
      const res = await WEBHOOK_GET(
        new NextRequest(`${URL}?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=x`),
      );
      expect(res.status).toBe(503);
    } finally {
      process.env.META_WEBHOOK_VERIFY_TOKEN = saved;
    }
  });

  /**
   * A blank-but-present app secret must not become a signing key: HMAC with a
   * guessable key is a perfectly computable signature, so accepting one would
   * let anybody forge a delivery. instagramAppCredentials() trims, so a
   * whitespace-only Instagram secret has to count as "not configured".
   */
  it("treats a whitespace-only Instagram app secret as not configured", async () => {
    const ig = process.env.META_INSTAGRAM_APP_SECRET;
    const fb = process.env.META_APP_SECRET;
    process.env.META_INSTAGRAM_APP_SECRET = "   ";
    delete process.env.META_APP_SECRET;
    try {
      const body = delivery(["mid.forged"]);
      const res = await WEBHOOK_POST(post(body, sign(body, "   ")));
      expect(res.status).toBe(503);
      expect(store.webhookEvent).toHaveLength(0);
    } finally {
      process.env.META_INSTAGRAM_APP_SECRET = ig;
      process.env.META_APP_SECRET = fb;
    }
  });
});

describe("[audit] automation actions the first sweep never executed", () => {
  beforeEach(() => {
    seedAccount();
    seedConversation();
  });

  /**
   * SEND_PRIVATE_REPLY is one of the five outbound action types the rule editor
   * offers, and NO test anywhere in the repo ran it — only one asserting that
   * its name appears in OUTBOUND_ACTIONS. That set membership is what makes the
   * master switch and the rate limit apply to it, so it is asserted here too.
   */
  it("SEND_PRIVATE_REPLY DMs the commenter by comment id, not by igsid", async () => {
    seedRule({ id: "r_pr", actions: [{ type: "SEND_PRIVATE_REPLY", params: { text: "Narxlar DMda" } }] });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_9", igsid: "cust_1" });

    expect(graphMock).toHaveBeenCalledTimes(1);
    const call = graphMock.mock.calls[0]![0]!;
    expect(call.path).toBe("ig_1/messages");
    const body = call.body as GraphBody;
    expect(body.recipient).toEqual({ comment_id: "cmt_9" });
    expect(body.recipient?.id).toBeUndefined();
    expect(body.message?.text).toBe("Narxlar DMda");
    // a private reply is a 7-day window, not the 24h one — no messaging_type
    expect(body.messaging_type).toBeUndefined();
    expect(lastRun()!.status).toBe("SUCCESS");
  });

  it("SEND_PRIVATE_REPLY is an OUTBOUND action: the master switch stops it before Meta", async () => {
    store.globalSettings[0]!.masterAutomationEnabled = false;
    seedRule({ id: "r_pr", actions: [{ type: "SEND_PRIVATE_REPLY", params: { text: "hi" } }] });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_9" });

    expect(graphMock).not.toHaveBeenCalled();
    expect(String(lastRun()!.error)).toMatch(/master automation switch OFF/);
  });

  it("SEND_PRIVATE_REPLY on a trigger that carries no comment fails with a named reason", async () => {
    seedRule({
      id: "r_pr",
      trigger: "MESSAGE_RECEIVED",
      actions: [{ type: "SEND_PRIVATE_REPLY", params: { text: "hi" } }],
    });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1", conversationId: "conv_1" });

    expect(graphMock).not.toHaveBeenCalled();
    expect(String(lastRun()!.error)).toBe("no comment in context");
  });

  it("SEND_COMMENT_RESOURCE with no resource attached sends the caption as the reply text", async () => {
    seedRule({
      id: "r",
      actions: [{ type: "SEND_COMMENT_RESOURCE", params: { mode: "template", text: "Narx: 500000" } }],
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1" });

    expect(graphMock).toHaveBeenCalledTimes(1);
    const body = graphMock.mock.calls[0]![0]!.body as GraphBody;
    expect(body.recipient).toEqual({ comment_id: "cmt_1" });
    expect(body.message?.text).toBe("Narx: 500000");
    expect(body.message?.attachment).toBeUndefined();
    expect(lastRun()!.status).toBe("SUCCESS");
    // nothing was dropped, so the run line carries no "caption not sent" note
    expect(lastRun()!.error ?? null).toBeNull();
  });

  it("SEND_COMMENT_RESOURCE in AI mode refuses to send when no agent is configured", async () => {
    seedRule({ id: "r", actions: [{ type: "SEND_COMMENT_RESOURCE", params: { mode: "ai", text: "javob ber" } }] });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1", text: "narx?" });

    expect(graphMock).not.toHaveBeenCalled();
    expect(String(lastRun()!.error)).toBe("no agent configured for AI mode");
  });

  /**
   * The agentId lives in admin-supplied rule JSON, exactly like the lead-flow
   * flowId that gets an explicit ownership guard. Another account's agent must
   * not answer this account's customers.
   */
  it("SEND_COMMENT_RESOURCE in AI mode will not borrow another account's agent", async () => {
    store.aIAgent.push({ id: "agent_x", accountId: "acc_other", systemPrompt: "you are helpful" });
    seedRule({
      id: "r",
      actions: [{ type: "SEND_COMMENT_RESOURCE", params: { mode: "ai", text: "javob", agentId: "agent_x" } }],
    });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1", text: "narx?" });

    expect(graphMock).not.toHaveBeenCalled();
    expect(String(lastRun()!.error)).toBe("agent not found");
  });

  it("an action whose account row has vanished fails loudly instead of sending", async () => {
    store.instagramAccount.length = 0; // account deleted between trigger and run
    seedRule({ id: "r", actions: [{ type: "REPLY_COMMENT", params: { text: "hi" } }] });

    await runAutomations("COMMENT_RECEIVED", { accountId: "acc_1", commentId: "cmt_1" });

    expect(graphMock).not.toHaveBeenCalled();
    expect(String(lastRun()!.error)).toBe("account not found");
  });

  it("SEND_MESSAGE against a conversation that no longer exists fails loudly", async () => {
    seedRule({ id: "r", trigger: "MESSAGE_RECEIVED", actions: [{ type: "SEND_MESSAGE", params: { text: "hi" } }] });

    await runAutomations("MESSAGE_RECEIVED", { accountId: "acc_1", conversationId: "conv_gone" });

    expect(graphMock).not.toHaveBeenCalled();
    expect(store.message).toHaveLength(0);
    expect(String(lastRun()!.error)).toBe("conversation not found");
  });

  it("SET_LEAD_STATUS accepts every CRM status and only those", async () => {
    for (const status of ["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"]) {
      resetStore();
      seedAccount();
      store.lead.push({ id: "lead_1", accountId: "acc_1", status: "NEW" });
      seedRule({ id: "r", trigger: "LEAD_SUBMITTED", actions: [{ type: "SET_LEAD_STATUS", params: { status } }] });
      await runAutomations("LEAD_SUBMITTED", { accountId: "acc_1", leadId: "lead_1" });
      expect(store.lead[0]!.status, status).toBe(status);
      expect(lastRun()!.status, status).toBe("SUCCESS");
    }
    for (const bad of ["won", "ARCHIVED", ""]) {
      resetStore();
      seedAccount();
      store.lead.push({ id: "lead_1", accountId: "acc_1", status: "NEW" });
      seedRule({
        id: "r",
        trigger: "LEAD_SUBMITTED",
        actions: [{ type: "SET_LEAD_STATUS", params: { status: bad } }],
      });
      await runAutomations("LEAD_SUBMITTED", { accountId: "acc_1", leadId: "lead_1" });
      expect(store.lead[0]!.status, bad).toBe("NEW");
      expect(String(lastRun()!.error), bad).toBe("invalid status");
    }
  });
});

describe("[audit] allConditionsMatch, directly", () => {
  const ctx = { accountId: "a", text: "Kurs narxi qancha", username: "vip_aziz" };

  it("an empty or absent condition list lets every matching trigger through", () => {
    expect(allConditionsMatch([], ctx)).toBe(true);
    expect(allConditionsMatch(null, ctx)).toBe(true);
    expect(allConditionsMatch(undefined, ctx)).toBe(true);
    expect(allConditionsMatch("not an array", ctx)).toBe(true);
  });

  it("ANDs the list: every condition must hold", () => {
    const narx = { field: "text", op: "contains", value: "narx" };
    const vip = { field: "username", op: "starts_with", value: "vip_" };
    const refund = { field: "text", op: "contains", value: "refund" };
    expect(allConditionsMatch([narx, vip], ctx)).toBe(true);
    expect(allConditionsMatch([narx, refund], ctx)).toBe(false);
    expect(allConditionsMatch([refund, narx], ctx)).toBe(false); // order must not matter
  });

  it("a junk entry in the list is ignored rather than crashing the run", () => {
    const narx = { field: "text", op: "contains", value: "narx" };
    expect(allConditionsMatch([null, narx], ctx)).toBe(true);
    expect(allConditionsMatch([{ nonsense: 1 }, narx], ctx)).toBe(true);
    // ...but it must not neutralise a real condition standing next to it
    expect(allConditionsMatch([{ nonsense: 1 }, { field: "text", op: "contains", value: "refund" }], ctx)).toBe(false);
  });
});

describe("[audit] rate limiter honesty", () => {
  it("the retry-after it reports is a real wait: at least a second, never longer than the window", () => {
    const { limit, windowMs } = LIMITS.AUTOMATION_ACCOUNT;
    for (let i = 0; i < limit; i++) expect(rateLimit("audit:key", limit, windowMs).allowed).toBe(true);

    const blocked = rateLimit("audit:key", limit, windowMs);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(Math.ceil(windowMs / 1000));
  });

  it("counts down the remaining budget instead of reporting a constant", () => {
    const seen = Array.from({ length: 5 }, () => rateLimit("audit:countdown", 5, 60_000).remaining);
    expect(seen).toEqual([4, 3, 2, 1, 0]);
  });
});

describe("[audit] capability gaps", () => {
  const live = (kind: "user" | "page" | "ads", scopes: string[], expiresAt: Date | null = null) =>
    ({
      id: `tk_${kind}_${expiresAt?.getTime() ?? "never"}`,
      accountId: "a1",
      kind,
      encrypted: "x",
      status: "ACTIVE",
      scopes,
      issuedAt: new Date(),
      expiresAt,
      lastRefreshAt: null,
      lastCheckedAt: null,
    }) as AccountWithAuth["tokens"][number];

  const acct = (over: Partial<AccountWithAuth>): AccountWithAuth =>
    ({
      id: "a1",
      igUserId: "178",
      username: "biz",
      connectionMode: "FACEBOOK_LOGIN",
      fbPageId: "p1",
      adAccountId: null,
      status: "CONNECTED",
      webhookSubscribed: true,
      isDemo: false,
      permissions: [],
      tokens: [],
      ...over,
    }) as AccountWithAuth;

  it("an EXPIRED page token puts a Facebook-Login account back to 'reconnect', same as mode A", () => {
    const caps = capabilityMap(
      detectCapabilities(acct({ tokens: [live("page", ["instagram_manage_messages"], new Date(Date.now() - 1000))] })),
    );
    expect(caps.messaging.available).toBe(false);
    expect(caps.messaging.reason).toMatch(/expired or revoked/i);
  });

  /**
   * A never-connected account has to read as "connect it", never as a half-lit
   * page: every organic feature off, each with a reason a human can act on.
   */
  it("an account with no tokens at all reports every organic capability off, with a reason", () => {
    const caps = capabilityMap(detectCapabilities(acct({ connectionMode: "INSTAGRAM_LOGIN", fbPageId: null })));
    for (const key of ["messaging", "publishing", "comments", "insights"] as const) {
      expect(caps[key].available, key).toBe(false);
      expect(caps[key].reason, key).toBeTruthy();
    }
    expect(caps.ads.available).toBe(false);
    expect(caps.lead_forms.available).toBe(false);
  });

  it("detectCapabilities does not reorder the account's own token rows", () => {
    // adsTokenRow() sorts candidate rows; sorting acc.tokens in place would
    // silently reshuffle a caller's array — the same object the page renders.
    const tokens = [live("ads", ["ads_management"]), live("user", ["instagram_business_basic"])];
    const before = tokens.map((t) => t.id);
    detectCapabilities(acct({ adAccountId: "act_1", tokens }));
    expect(tokens.map((t) => t.id)).toEqual(before);
  });
});

describe("[audit] the keyword boundary really is Unicode, not \\b", () => {
  /**
   * JavaScript's \b is defined over [A-Za-z0-9_]. A \b-based implementation
   * would not match a Cyrillic keyword AT ALL, so a test that only proves "цен"
   * matches "цены" is also passed by a plain substring search. Both halves are
   * needed: the suffix match must work AND the buried one must not.
   */
  it("matches a Cyrillic stem with a suffix but not one buried mid-word", () => {
    expect(keywordMatches("цены низкие", "цен")).toBe(true);
    expect(keywordMatches("Оценка работы", "цен")).toBe(false);
    expect(keywordMatches("расценки", "цен")).toBe(false);
  });

  it("the same for Uzbek Latin, where a digit or underscore is also a word char", () => {
    expect(keywordMatches("narx1 qancha", "narx")).toBe(true); // keyword starts the word
    expect(keywordMatches("kurs_narx", "narx")).toBe(false); // underscore glues it on
    expect(keywordMatches("2narx", "narx")).toBe(false);
  });

  it("a punctuation-led keyword still matches a bare hashtag", () => {
    expect(keywordMatches("salom #narx bormi", "#narx")).toBe(true);
  });
});

describe("[audit] private reply and token-exchange leftovers", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("a demo account's private reply never reaches Meta", async () => {
    const demo = {
      id: "acct_1",
      connectionMode: "INSTAGRAM_LOGIN",
      igUserId: "ig_1",
      isDemo: true,
    } as unknown as InstagramAccount;
    const res = await sendPrivateReplyToComment(demo, "cmt_1", "salom");
    expect(res.messageId).toMatch(/^demo-/);
    expect(graphMock).not.toHaveBeenCalled();
  });

  it("fbExchangeCode falls back to one hour when Meta omits expires_in on the short token", async () => {
    stubFetch({ body: { access_token: "fb_short" } });
    const out = await fbExchangeCode("c");
    expect(out).toEqual({ accessToken: "fb_short", expiresInSec: 3600 });
    expect(new Date(Date.now() + out.expiresInSec * 1000).getTime()).not.toBeNaN();
  });

  it("a zero or negative expires_in cannot produce an already-expired token", async () => {
    for (const bogus of [0, -1]) {
      stubFetch({ body: { access_token: "long", expires_in: bogus } });
      const out = await igExchangeLongLived("s");
      expect(out.expiresInSec, String(bogus)).toBeGreaterThan(0);
      expect(new Date(Date.now() + out.expiresInSec * 1000).getTime(), String(bogus)).toBeGreaterThan(Date.now());
      vi.unstubAllGlobals();
    }
  });

  it("igExchangeCode refuses a 200 that carries a token but no user id", async () => {
    stubFetch({ body: { access_token: "short_only" } });
    await expect(igExchangeCode("c")).rejects.toMatchObject({ code: "META_AUTH_FAILED" });
  });
});

/* ================================================================== *
 * AUDIT PASS 2 — the byte clamp, against the characters Instagram
 * actually carries.
 *
 * The existing clamp tests use "ў": 2 UTF-8 bytes but ONE UTF-16 code
 * unit, so a clamp that slices UTF-16 units can never be caught by
 * them. An emoji is one character made of TWO code units, and that is
 * the case that matters — every second Instagram DM has one.
 * ================================================================== */

describe("[audit] clampTextBytes against emoji and very long text", () => {
  /** code units in the surrogate range that are not part of a valid pair */
  function loneSurrogates(s: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const u = s.charCodeAt(i);
      if (u >= 0xd800 && u <= 0xdbff) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) i++;
        else out.push(u);
      } else if (u >= 0xdc00 && u <= 0xdfff) {
        out.push(u);
      }
    }
    return out;
  }

  it("the helper itself finds a lone surrogate and clears a clean string", () => {
    expect(loneSurrogates("salom 😀")).toEqual([]);
    expect(loneSurrogates("salom \ud83d")).toEqual([0xd83d]);
  });

  /**
   * The clamp walked BACKWARDS one UTF-16 code unit at a time, so when the byte
   * budget ran out between the two halves of an emoji it stopped there and
   * returned a string ending in a lone high surrogate. The "ab" prefix is only
   * there to line the parity up — any message whose emoji straddles the 1000th
   * byte does it.
   */
  it("never cuts an emoji in half, whatever the byte parity of what precedes it", () => {
    for (const prefix of ["", "a", "ab", "abc", "салом ", "narx: "]) {
      const out = clampTextBytes(prefix + "😀".repeat(400));
      const bytes = new TextEncoder().encode(out);
      expect(bytes.length, prefix).toBeLessThanOrEqual(MAX_TEXT_BYTES);
      expect(loneSurrogates(out), `prefix ${JSON.stringify(prefix)}`).toEqual([]);
      // a split code point survives encode() only as U+FFFD, so the round trip
      // through UTF-8 is the same assertion from the wire's point of view
      expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes), prefix).toBe(out);
    }
  });

  /**
   * The concrete consequence: the Send API body is serialised and written as
   * UTF-8. A lone surrogate does not survive that — it becomes U+FFFD — so the
   * customer receives a replacement character where the emoji was.
   */
  it("the DM that reaches Meta survives being written to the wire as UTF-8", async () => {
    const acct = {
      id: "acc_1",
      igUserId: "ig_1",
      connectionMode: "INSTAGRAM_LOGIN",
      isDemo: false,
    } as unknown as InstagramAccount;

    await sendInstagramText(acct, "cust", "ab" + "😀".repeat(400), { lastUserMessageAt: new Date() });

    const body = graphMock.mock.calls[0]![0]!.body as GraphBody;
    const json = JSON.stringify(body);
    expect(Buffer.from(json, "utf8").toString("utf8")).toBe(json);
    expect(loneSurrogates(body.message!.text!)).toEqual([]);
  });

  it("a mixed emoji/Cyrillic message is clamped to whole characters and still fills the budget", () => {
    const out = clampTextBytes("Assalomu alaykum! 😀 Narx 500000 so'm. ".repeat(60));
    const bytes = new TextEncoder().encode(out);
    expect(bytes.length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
    expect(bytes.length).toBeGreaterThan(MAX_TEXT_BYTES - 8); // whole-character step, not a giveaway
    expect(loneSurrogates(out)).toEqual([]);
    expect(out.endsWith("…")).toBe(true);
  });

  /**
   * The clamp re-encoded the WHOLE remaining string on every step, so the cost
   * was quadratic in the input: a 200 000-character message (an admin pasting a
   * document into a rule template, a runaway AI reply) took about two MINUTES
   * of blocked event loop before a single DM went out.
   */
  it(
    "clamps a very long message in bounded time",
    () => {
      const huge = "x".repeat(200_000);
      const started = Date.now();
      const out = clampTextBytes(huge);
      const elapsed = Date.now() - started;
      expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(MAX_TEXT_BYTES);
      expect(out.endsWith("…")).toBe(true);
      expect(elapsed).toBeLessThan(2000);
    },
    { timeout: 20_000 },
  );

  it("still returns short text untouched and never pads it", () => {
    expect(clampTextBytes("salom 😀")).toBe("salom 😀");
    expect(clampTextBytes("")).toBe("");
    // exactly at the budget is inside it
    const exact = "a".repeat(MAX_TEXT_BYTES);
    expect(clampTextBytes(exact)).toBe(exact);
    expect(clampTextBytes("a".repeat(MAX_TEXT_BYTES + 1)).endsWith("…")).toBe(true);
  });

  /**
   * buildPrivateReplyMessage hands clampTextBytes a budget that a long
   * admin-pasted file link can squeeze to nothing. It must never answer with
   * MORE bytes than it was given — that would be the clamp overshooting the
   * very limit it exists to enforce.
   */
  it("never returns more bytes than the budget it was handed, however small", () => {
    for (const budget of [1, 2, 3, 4, 5, 10, 50]) {
      const out = clampTextBytes("narxlar ro'yxati 😀 juda uzun sarlavha", budget);
      expect(new TextEncoder().encode(out).length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(loneSurrogates(out), `budget ${budget}`).toEqual([]);
    }
  });
});

/* ================================================================== *
 * AUDIT PASS 3 — two of the customer's messages in flight at once.
 *
 * Every webhook POST ends with after(() => drainNow()), and drainNow
 * takes no cross-invocation lock. Two messages from the same person
 * arrive as two deliveries, so two drains run side by side, each
 * claiming a different job and each reading the SAME lead-flow session
 * before the other writes. Both then hold a snapshot saying the session
 * sits on question N. This is what that looks like.
 * ================================================================== */

describe("[audit] a lead flow session under two concurrent messages", () => {
  beforeEach(async () => {
    seedAccount();
    seedConversation();
    threeQuestionFlow();
    await startFlowSession({ flowId: "flow_1", accountId: "acc_1", conversationId: "conv_1" });
  });

  /** What a second worker holds: the row as it looked before the first worker wrote. */
  const snapshot = () => ({ ...(store.leadFlowSession.find((s) => s.status === "ACTIVE") as object) }) as never;

  it("does not write the second message as the answer to the question the first one just answered", async () => {
    const first = snapshot();
    const second = snapshot(); // same state — both workers read before either wrote

    await handleFlowAnswer(first, "Aziz"); // answers q_name, advances to q_phone
    await handleFlowAnswer(second, "+998901234567"); // the customer's SECOND message

    const nameAnswer = store.leadAnswer.find((a) => a.questionId === "q_name");
    // The phone number must never end up filed as the person's NAME.
    expect(nameAnswer!.value).toBe("Aziz");
    expect(store.leadAnswer.filter((a) => a.questionId === "q_name")).toHaveLength(1);
  });

  it("does not rewind the session, so the customer is not asked the same question twice", async () => {
    const first = snapshot();
    const second = snapshot();

    const a = await handleFlowAnswer(first, "Aziz");
    const b = await handleFlowAnswer(second, "Aziza");

    expect(a.messages[0]!.text).toBe("Telefon raqamingiz?");
    // the second worker must not re-send the question the first already moved past
    expect(b.messages.map((m) => m.text)).not.toContain("Ismingiz?");
    expect(activeSessionRow()!.currentQuestionId).toBe("q_phone");
  });

  /**
   * The same race on the LAST question is the expensive one: completeSession()
   * creates a Lead row unconditionally, so a stale snapshot run a second time
   * puts a duplicate of the same person into the CRM — with a duplicate CREATED
   * event and the conversation re-pointed at the second one.
   */
  it("completes once: a replayed final answer cannot create a second lead", async () => {
    await handleFlowAnswer(activeSessionRow() as never, "Aziz");
    await handleFlowAnswer(activeSessionRow() as never, "+998901234567");
    const beforeLast = snapshot(); // a second worker's view, still on the last question

    const done = await handleFlowAnswer(activeSessionRow() as never, "1");
    expect(done.sessionStatus).toBe("COMPLETED");
    expect(store.lead).toHaveLength(1);

    await handleFlowAnswer(beforeLast, "2"); // the replay

    expect(store.lead).toHaveLength(1);
    expect(store.leadEvent).toHaveLength(1);
    expect(store.leadFlowSession.filter((s) => s.status === "COMPLETED")).toHaveLength(1);
    expect(store.conversation[0]!.leadId).toBe(store.lead[0]!.id);
  });

  it("a cancelled session cannot be answered back into life", async () => {
    const stale = snapshot();
    await handleFlowAnswer(activeSessionRow() as never, "bekor");
    expect(store.leadFlowSession[0]!.status).toBe("CANCELLED");

    await handleFlowAnswer(stale, "Aziz");

    expect(store.leadFlowSession[0]!.status).toBe("CANCELLED");
    expect(store.leadAnswer).toHaveLength(0);
    expect(store.lead).toHaveLength(0);
  });

  it("the ordinary one-message-at-a-time path is untouched", async () => {
    const first = await handleFlowAnswer(activeSessionRow() as never, "Aziz");
    expect(first.messages[0]!.text).toBe("Telefon raqamingiz?");
    const second = await handleFlowAnswer(activeSessionRow() as never, "+998901234567");
    expect(second.messages[0]!.text).toContain("Qaysi shahardansiz?");
    const third = await handleFlowAnswer(activeSessionRow() as never, "1");
    expect(third.sessionStatus).toBe("COMPLETED");
    expect(store.lead).toHaveLength(1);
    expect(store.leadAnswer).toHaveLength(3);
  });

  it("an invalid answer still re-prompts rather than being treated as a lost race", async () => {
    await handleFlowAnswer(activeSessionRow() as never, "Aziz");
    const bad = await handleFlowAnswer(activeSessionRow() as never, "not a phone");
    expect(bad.sessionStatus).toBe("ACTIVE");
    expect(bad.messages[0]!.text).toMatch(/valid phone number/i);
    expect(activeSessionRow()!.currentQuestionId).toBe("q_phone");
  });
});
