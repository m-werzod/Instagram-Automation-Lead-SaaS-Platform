import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job } from "@prisma/client";
import {
  buildContainerParams,
  describePublishError,
  extensionFor,
  hostedMediaUrl,
  isJpeg,
  kindFromUrl,
  kindFromUrlOrNull,
  parseContainerStatus,
  parsePublishingLimit,
  publishRunKey,
  runPublishJob,
  EARLY_WAKE_MARGIN_MS,
  POLL_DELAY_MS,
  PUBLISH_PASS_LEASE_MS,
  PUBLISH_QUOTA_ERROR_CODE,
  QUOTA_RETRY_DELAY_MS,
  RATE_LIMIT_RETRY_DELAY_MS,
  resolveItemKind,
  retryDelayForPublishError,
  scheduleKey,
  validatePublishInput,
  wakeKey,
  wakeRunAt,
} from "@/lib/meta/publishing";
import { insightMetricsFor } from "@/lib/meta/media";
import { contentDispositionFor } from "@/lib/resources";
import { MetaApiError } from "@/lib/meta/client";
import { jobTimeoutMs, processJob, registerHandler } from "@/lib/queue";

type Row = Record<string, unknown>;

/**
 * The publish state machine is bookkeeping between two tables plus a handful of
 * Graph calls, so it runs here against in-memory stand-ins for both — no
 * database, no network. The database's clock is a value a test sets, because
 * disagreeing with it is exactly what used to strand scheduled posts.
 */
const { store, prismaMock, graphMock, resolveAccessMock } = vi.hoisted(() => {
  const store = {
    publishJobs: [] as Row[],
    jobs: [] as Row[],
    seq: 0,
    dbNow: Date.now(),
    /** What the mocked Graph API answers this test. */
    graph: (async () => ({})) as (args: { path: string; method?: string }) => Promise<unknown>,
  };

  const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === "OR") return (cond as Row[]).some((c) => matches(row, c));
      const value = row[key];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as Record<string, unknown>;
        if ("not" in c) return !same(value, c.not);
        if ("notIn" in c) return !(c.notIn as unknown[]).includes(value);
        if ("in" in c) return (c.in as unknown[]).includes(value);
        if ("lt" in c) return value instanceof Date && value.getTime() < (c.lt as Date).getTime();
        return false;
      }
      return same(value, cond);
    });

  const table = (rows: Row[], make: (data: Row) => Row, decorate?: (row: Row, args: Row) => Row) => ({
    create: async ({ data }: { data: Row }) => {
      const row = make(data);
      rows.push(row);
      return { ...row };
    },
    findUnique: async ({ where, ...args }: { where: Row } & Row) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) return null;
      return decorate ? decorate({ ...row }, args) : { ...row };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error("record not found");
      Object.assign(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
    upsert: async () => ({}),
  });

  return {
    store,
    graphMock: vi.fn(async (args: { path: string; method?: string }) => store.graph(args)),
    resolveAccessMock: vi.fn(async () => ({ host: "graph.instagram.com", accessToken: "tok" })),
    prismaMock: {
      publishJob: table(
        store.publishJobs,
        (data) => ({ id: `pj${++store.seq}`, attempts: 0, childContainerIds: [], ...data }),
        (row, args) => ((args.include as Row | undefined)?.account ? { ...row, account: { id: "acc1", igUserId: "ig1", isDemo: false } } : row),
      ),
      job: table(store.jobs, (data) => {
        if (data.idempotencyKey && store.jobs.some((j) => j.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error("Unique constraint failed on idempotencyKey"), { code: "P2002" });
        }
        return { id: `q${++store.seq}`, status: "PENDING", attempts: 0, maxAttempts: 5, lockedBy: null, ...data };
      }),
      contentItem: { upsert: async () => ({}) },
      $queryRaw: async () => [{ now: new Date(store.dbNow) }],
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  graphCall: graphMock,
}));

vi.mock("@/lib/meta/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/tokens")>()),
  resolveAccess: resolveAccessMock,
}));

beforeEach(() => {
  store.publishJobs.length = 0;
  store.jobs.length = 0;
  store.seq = 0;
  store.dbNow = Date.parse("2026-10-01T09:00:00Z");
  store.graph = async () => ({});
  graphMock.mockClear();
});

function seedPublishJob(row: Row = {}): Row {
  const seeded: Row = {
    id: `pj-${store.publishJobs.length + 1}`,
    accountId: "acc1",
    mediaType: "IMAGE",
    caption: null,
    items: [{ url: "https://cdn.example.com/a.jpg", kind: "IMAGE" }],
    shareToFeed: null,
    coverUrl: null,
    status: "SCHEDULED",
    scheduledAt: new Date(store.dbNow - 1000),
    startedAt: null,
    publishedAt: null,
    containerId: null,
    childContainerIds: [],
    publishedMediaId: null,
    permalink: null,
    attempts: 0,
    lastError: null,
    ...row,
  };
  store.publishJobs.push(seeded);
  return seeded;
}

const keyOf = (job: Row, now: number) => wakeKey({ id: job.id as string, scheduledAt: job.scheduledAt as Date }, now);
const queuedPasses = () => store.jobs.filter((j) => j.type === "publish.run");
const pendingPasses = () => queuedPasses().filter((j) => j.status === "PENDING");

/**
 * Publishing maps onto Meta's container → status → media_publish protocol.
 * The pure parts are pinned here: what we refuse before calling Meta, the exact
 * container parameters per media type, and how Meta's answers are read.
 */

const img = { url: "https://cdn.example.com/a.jpg", kind: "IMAGE" as const };
const vid = { url: "https://cdn.example.com/a.mp4", kind: "VIDEO" as const };

describe("validatePublishInput", () => {
  it("accepts a plain photo post", () => {
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], caption: "hi" })).toBeNull();
  });
  it("requires the right media kind per type", () => {
    expect(validatePublishInput({ mediaType: "IMAGE", items: [vid] })).toMatch(/image/);
    expect(validatePublishInput({ mediaType: "REELS", items: [img] })).toMatch(/video/);
    expect(validatePublishInput({ mediaType: "STORIES", items: [img] })).toBeNull();
    expect(validatePublishInput({ mediaType: "STORIES", items: [vid] })).toBeNull();
  });
  it("enforces carousel size 2–10 and one item otherwise", () => {
    expect(validatePublishInput({ mediaType: "CAROUSEL", items: [img] })).toMatch(/2–10/);
    expect(validatePublishInput({ mediaType: "CAROUSEL", items: Array(11).fill(img) })).toMatch(/2–10/);
    expect(validatePublishInput({ mediaType: "CAROUSEL", items: [img, vid] })).toBeNull();
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img, img] })).toMatch(/Exactly one/);
  });
  it("refuses non-https media and over-long captions", () => {
    expect(validatePublishInput({ mediaType: "IMAGE", items: [{ url: "http://x/a.jpg", kind: "IMAGE" }] })).toMatch(/https/);
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], caption: "x".repeat(2201) })).toMatch(/2200/);
  });
  it("bounds the schedule window", () => {
    const now = new Date("2026-09-12T12:00:00Z");
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], scheduledAt: new Date("2026-09-12T11:00:00Z"), now })).toMatch(/past/);
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], scheduledAt: new Date("2026-12-31T11:00:00Z"), now })).toMatch(/75 days/);
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], scheduledAt: new Date("2026-09-13T11:00:00Z"), now })).toBeNull();
  });
});

describe("buildContainerParams", () => {
  it("photo: image_url + caption, no children", () => {
    const p = buildContainerParams({ mediaType: "IMAGE", items: [img], caption: " Hello " });
    expect(p.children).toEqual([]);
    expect(p.main([])).toEqual({ image_url: img.url, caption: "Hello" });
  });
  it("reel: media_type REELS, video_url, share_to_feed and cover", () => {
    const p = buildContainerParams({ mediaType: "REELS", items: [vid], caption: "c", shareToFeed: false, coverUrl: "https://cdn/c.jpg" });
    expect(p.main([])).toEqual({ media_type: "REELS", video_url: vid.url, caption: "c", share_to_feed: false, cover_url: "https://cdn/c.jpg" });
  });
  it("story: STORIES with the matching url field and never a caption", () => {
    expect(buildContainerParams({ mediaType: "STORIES", items: [img], caption: "ignored" }).main([])).toEqual({ media_type: "STORIES", image_url: img.url });
    expect(buildContainerParams({ mediaType: "STORIES", items: [vid] }).main([])).toEqual({ media_type: "STORIES", video_url: vid.url });
  });
  it("carousel: children flagged is_carousel_item, parent lists their ids", () => {
    const p = buildContainerParams({ mediaType: "CAROUSEL", items: [img, vid], caption: "album" });
    expect(p.children).toEqual([
      { is_carousel_item: true, image_url: img.url },
      { is_carousel_item: true, media_type: "VIDEO", video_url: vid.url },
    ]);
    expect(p.main(["1", "2"])).toEqual({ media_type: "CAROUSEL", children: "1,2", caption: "album" });
  });
});

describe("reading Meta's answers", () => {
  it("maps status_code values and keeps the human status line", () => {
    expect(parseContainerStatus({ status_code: "FINISHED" })).toEqual({ code: "FINISHED", message: null });
    expect(parseContainerStatus({ status_code: "ERROR", status: "Error: Media aspect ratio invalid" })).toEqual({
      code: "ERROR",
      message: "Error: Media aspect ratio invalid",
    });
    expect(parseContainerStatus({}).code).toBe("UNKNOWN");
  });
  it("reads the publishing quota, defaulting the total to Meta's 100", () => {
    expect(parsePublishingLimit({ data: [{ quota_usage: 7, config: { quota_total: 100 } }] })).toEqual({ used: 7, quota: 100 });
    expect(parsePublishingLimit({ data: [{ quota_usage: 3 }] })).toEqual({ used: 3, quota: 100 });
    expect(parsePublishingLimit({ data: [] })).toBeNull();
  });
  it("explains a Meta error in one admin-readable line", () => {
    const err = new MetaApiError({ message: "Invalid parameter", code: 100, error_user_msg: "The video format is not supported." }, 400);
    expect(describePublishError(err)).toMatch(/video format is not supported/);
    expect(describePublishError(new Error("boom"))).toBe("boom");
  });
});

describe("hosted media", () => {
  it("builds a public URL with the extension Meta expects", () => {
    expect(hostedMediaUrl("abc123", "image/jpeg")).toBe("http://localhost:3000/m/abc123.jpg");
    expect(extensionFor("video/mp4")).toBe("mp4");
    expect(extensionFor("image/png")).toBe("bin");
  });
  it("recognises JPEG by signature, not by name", () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe(true);
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG
  });
  it("infers the kind of a pasted URL from its extension", () => {
    expect(kindFromUrl("https://x/clip.MP4?token=1")).toBe("VIDEO");
    expect(kindFromUrl("https://x/photo.jpg")).toBe("IMAGE");
  });
});

describe("resolveItemKind", () => {
  const signed = "https://cdn.example.com/assets/9f2b?Expires=1&Signature=abc"; // no extension at all

  it("fills a format-less URL in from the media type, where only one kind is legal", () => {
    expect(resolveItemKind("REELS", signed)).toBe("VIDEO");
    expect(resolveItemKind("IMAGE", signed)).toBe("IMAGE");
    // the extension heuristic alone called the signed URL an image and made the Reel unpublishable
    expect(kindFromUrl(signed)).toBe("IMAGE");
  });

  it("honours an explicit kind where both are legal, and guesses only as a last resort", () => {
    expect(resolveItemKind("STORIES", signed, "VIDEO")).toBe("VIDEO");
    expect(resolveItemKind("CAROUSEL", signed, "VIDEO")).toBe("VIDEO");
    expect(resolveItemKind("STORIES", signed)).toBe("IMAGE");
    expect(resolveItemKind("CAROUSEL", "https://x/a.mov")).toBe("VIDEO");
  });

  it("ignores a caller's kind where the media type already settles it", () => {
    expect(resolveItemKind("REELS", signed, "IMAGE")).toBe("VIDEO");
    expect(resolveItemKind("IMAGE", signed, "VIDEO")).toBe("IMAGE");
  });

  it("keeps a URL that names a contradicting format, so the mismatch is refused here", () => {
    // coercing these to the chosen type queued a post that could only die at
    // Meta — the admin got a success toast for a publication that cannot work
    expect(resolveItemKind("IMAGE", "https://x/a.mp4", "VIDEO")).toBe("VIDEO");
    expect(resolveItemKind("REELS", "https://x/a.jpg")).toBe("IMAGE");
    expect(validatePublishInput({ mediaType: "IMAGE", items: [{ url: "https://x/a.mp4", kind: resolveItemKind("IMAGE", "https://x/a.mp4") }] })).toMatch(/image/);
    expect(validatePublishInput({ mediaType: "REELS", items: [{ url: "https://x/a.jpg", kind: resolveItemKind("REELS", "https://x/a.jpg") }] })).toMatch(/video/);
  });

  it("reads a format only from a real extension, never from the host name", () => {
    expect(kindFromUrlOrNull(signed)).toBeNull();
    expect(kindFromUrlOrNull("https://cdn.example.com")).toBeNull();
    expect(kindFromUrlOrNull("https://x/a.bin")).toBeNull();
    expect(kindFromUrlOrNull("https://x/clip.MOV?sig=1")).toBe("VIDEO");
    expect(kindFromUrlOrNull("https://x/photo.webp#frag")).toBe("IMAGE");
  });

  it("only ever produces a kind validatePublishInput then accepts", () => {
    // the two disagreed: the resolver's caller wrote IMAGE for a signed video
    // link and the validator rejected the Reel the admin had explicitly chosen
    for (const mediaType of ["IMAGE", "REELS", "STORIES"] as const) {
      expect(validatePublishInput({ mediaType, items: [{ url: signed, kind: resolveItemKind(mediaType, signed) }] })).toBeNull();
    }
    const carousel = [signed, "https://x/a.mp4"].map((url) => ({ url, kind: resolveItemKind("CAROUSEL", url) }));
    expect(validatePublishInput({ mediaType: "CAROUSEL", items: carousel })).toBeNull();
  });
});

describe("publish queue keys", () => {
  const job = { id: "job_1", scheduledAt: new Date("2026-10-01T09:00:00Z") };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never re-queues under the key the running row already holds", () => {
    // enqueue() drops a duplicate idempotencyKey, so an early wake-up that
    // re-used scheduleKey was a silent no-op and the post never went out
    vi.setSystemTime(new Date("2026-10-01T08:00:00Z"));
    expect(wakeKey(job)).not.toBe(scheduleKey(job));
  });

  it("collapses two workers waking the same job in one minute, and sleeps again in the next", () => {
    vi.setSystemTime(new Date("2026-10-01T08:00:10Z"));
    const first = wakeKey(job);
    vi.setSystemTime(new Date("2026-10-01T08:00:59Z"));
    expect(wakeKey(job)).toBe(first);
    vi.setSystemTime(new Date("2026-10-01T08:01:00Z"));
    expect(wakeKey(job)).not.toBe(first);
  });

  it("parks the sleeping row outside the minute its own key buckets on", () => {
    // the drain is a tight claim loop: parked at scheduledAt, a row the database
    // already considers due (its clock is what woke this pass early) comes back
    // in the same minute, re-enqueues under the same wakeKey, and enqueue drops
    // it — nothing queued, post abandoned. The margin is what ends that loop.
    vi.setSystemTime(new Date("2026-10-01T08:59:59Z"));
    const soon = new Date("2026-10-01T09:00:00Z"); // a second away — already due by the clock that woke us
    const sleeper = { id: "job_1", scheduledAt: soon };
    const keyNow = wakeKey(sleeper);
    const parked = wakeRunAt(soon);
    expect(parked.getTime()).toBeGreaterThan(soon.getTime());
    vi.setSystemTime(parked);
    expect(wakeKey(sleeper)).not.toBe(keyNow);
  });

  it("leaves a genuinely distant schedule exactly where it is", () => {
    vi.setSystemTime(new Date("2026-10-01T08:00:00Z"));
    expect(wakeRunAt(job.scheduledAt)).toBe(job.scheduledAt);
  });

  it("keeps every re-queue key of one job distinct from the others", () => {
    vi.setSystemTime(new Date("2026-10-01T08:00:00Z"));
    const keys = [
      scheduleKey(job),
      wakeKey(job),
      publishRunKey(job.id, "poll:1"),
      publishRunKey(job.id, "quota:1"),
      publishRunKey(job.id, "rl:1"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("retryDelayForPublishError", () => {
  const metaError = (code: number) => new MetaApiError({ message: "nope", code }, 400);

  it("waits out a spent publishing quota (code 9) instead of failing the post", () => {
    expect(retryDelayForPublishError(metaError(PUBLISH_QUOTA_ERROR_CODE))).toBe(QUOTA_RETRY_DELAY_MS);
  });

  it("still backs off on a plain rate limit", () => {
    expect(retryDelayForPublishError(metaError(4))).toBe(RATE_LIMIT_RETRY_DELAY_MS);
  });

  it("treats everything else as final for this post", () => {
    expect(retryDelayForPublishError(metaError(100))).toBeNull();
    expect(retryDelayForPublishError(new Error("boom"))).toBeNull();
  });
});

describe("insight metrics per media type", () => {
  it("never asks a story for metrics it does not have (Meta rejects the whole call)", () => {
    const story = insightMetricsFor("STORY");
    expect(story).toContain("replies");
    for (const absent of ["likes", "comments", "saved", "shares"]) expect(story).not.toContain(absent);
  });

  it("keeps the reel and feed sets", () => {
    expect(insightMetricsFor("REELS")).toContain("total_interactions");
    expect(insightMetricsFor("FEED").split(",")).toEqual(["views", "reach", "likes", "comments", "shares", "saved"]);
    expect(insightMetricsFor(null)).toBe(insightMetricsFor("FEED"));
  });

  it("matches however the product type is spelled — Meta says STORY, the publisher writes STORIES", () => {
    expect(insightMetricsFor("STORIES")).toBe(insightMetricsFor("STORY"));
    expect(insightMetricsFor("reels")).toBe(insightMetricsFor("REELS"));
  });
});

describe("contentDispositionFor", () => {
  it("keeps a non-Latin1 name readable without breaking the header", () => {
    const header = contentDispositionFor("Прайс-лист.pdf");
    // a raw UTF-8 header value throws inside the Response constructor → 500
    expect(header).toMatch(/^[\x20-\x7e]*$/);
    expect(header).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe("Прайс-лист.pdf");
  });

  it("gives a plain ASCII fallback and cannot inject a second header", () => {
    expect(contentDispositionFor("price list.pdf")).toBe(`inline; filename="price list.pdf"; filename*=UTF-8''price%20list.pdf`);
    const nasty = contentDispositionFor('a"\r\nX-Evil: 1.pdf');
    expect(nasty).toMatch(/^[\x20-\x7e]*$/); // no CR/LF survives into the header
    expect(nasty).toContain(`filename="a___X-Evil: 1.pdf"`);
  });

  it("percent-encodes what RFC 5987 does not allow in filename*", () => {
    // encodeURIComponent leaves ' ( ) * ! alone; they are not attr-chars
    const encoded = contentDispositionFor("o'brien (final)*.pdf").split("filename*=UTF-8''")[1]!;
    expect(encoded).not.toMatch(/['()*]/);
    expect(decodeURIComponent(encoded)).toBe("o'brien (final)*.pdf");
  });

  it("falls back to a name when there is none, and supports attachment", () => {
    expect(contentDispositionFor("   ")).toBe(`inline; filename="file"; filename*=UTF-8''file`);
    expect(contentDispositionFor("a.pdf", "attachment")).toMatch(/^attachment; /);
  });
});

describe("waking a scheduled post early", () => {
  afterEach(() => vi.useRealTimers());

  it("parks the next pass on the database's clock, never on this process's", async () => {
    // The database decides when a queue row runs. "Two minutes ahead" measured on
    // a worker clock that is two minutes behind is no wait at all: the row is
    // runnable again immediately and lands in the same minute bucket the key is
    // derived from, enqueue drops the re-queue as a duplicate — nothing queued,
    // and the post sits in SCHEDULED forever.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T08:00:00Z"));
    store.dbNow = Date.parse("2026-10-01T08:02:00Z");
    const job = seedPublishJob({ scheduledAt: new Date("2026-10-01T08:03:00Z") });

    await runPublishJob(job.id as string);

    expect(graphMock).not.toHaveBeenCalled();
    expect(queuedPasses()).toHaveLength(1);
    expect((queuedPasses()[0]!.runAt as Date).getTime()).toBe(store.dbNow + EARLY_WAKE_MARGIN_MS);
    expect(queuedPasses()[0]!.idempotencyKey).toBe(keyOf(job, store.dbNow));
    expect(queuedPasses()[0]!.idempotencyKey).not.toBe(keyOf(job, Date.now()));
  });

  it("re-queues under a fresh key when the key it derives is already spent", async () => {
    // The row this pass is running under can hold that very key. Dropping the
    // enqueue as a duplicate then leaves nothing queued at all.
    const job = seedPublishJob({ scheduledAt: new Date(store.dbNow + 3 * 60_000) });
    const key = keyOf(job, store.dbNow);
    store.jobs.push({ id: "q-spent", type: "publish.run", idempotencyKey: key, status: "COMPLETED", attempts: 1, maxAttempts: 3 });

    await runPublishJob(job.id as string);

    expect(pendingPasses()).toHaveLength(1);
    expect(pendingPasses()[0]!.idempotencyKey).not.toBe(key);
  });

  it("leaves the waking to a pass that really is still queued", async () => {
    const job = seedPublishJob({ scheduledAt: new Date(store.dbNow + 3 * 60_000) });
    const key = keyOf(job, store.dbNow);
    store.jobs.push({ id: "q-live", type: "publish.run", idempotencyKey: key, status: "PENDING", attempts: 0, maxAttempts: 3 });

    await runPublishJob(job.id as string);

    expect(pendingPasses()).toHaveLength(1); // the queued one, not a second copy
    expect(pendingPasses()[0]!.id).toBe("q-live");
  });
});

describe("one publish pass at a time", () => {
  it("does not start a second pass while another one holds the job", async () => {
    const heldSince = new Date(store.dbNow - 60_000);
    const job = seedPublishJob({ status: "PROCESSING", startedAt: heldSince });

    await runPublishJob(job.id as string);

    expect(graphMock).not.toHaveBeenCalled();
    expect(job.startedAt).toBe(heldSince); // the holder's fence is untouched
    expect(queuedPasses()).toHaveLength(1);
    expect((queuedPasses()[0]!.runAt as Date).getTime()).toBe(heldSince.getTime() + PUBLISH_PASS_LEASE_MS);
  });

  it("takes the job over once the holder's lease has lapsed", async () => {
    const job = seedPublishJob({ status: "PROCESSING", startedAt: new Date(store.dbNow - PUBLISH_PASS_LEASE_MS - 1000), containerId: "c1" });
    store.graph = async ({ path, method }) => (method === "POST" && path.endsWith("/media_publish") ? { id: "m1" } : { status_code: "FINISHED" });

    await runPublishJob(job.id as string);

    expect(job.status).toBe("PUBLISHED");
    expect(job.publishedMediaId).toBe("m1");
  });

  it("never publishes behind the pass that replaced it", async () => {
    // The queue's timeout abandons the await but cannot stop the handler, so an
    // abandoned pass runs on while the job is retried. Reaching media_publish
    // after a later pass took the job over is the second Instagram post.
    const job = seedPublishJob({ containerId: "c1" });
    let published = 0;
    store.graph = async ({ path, method }) => {
      if (method === "POST" && path.endsWith("/media_publish")) {
        published++;
        return { id: "m1" };
      }
      job.startedAt = new Date(store.dbNow + 5_000); // a later pass claims it mid-call
      return { status_code: "FINISHED" };
    };

    await runPublishJob(job.id as string);

    expect(published).toBe(0);
    expect(job.status).toBe("PROCESSING"); // left to its new owner, not failed
  });

  it("stops before publishing once the queue has abandoned the pass", async () => {
    const controller = new AbortController();
    const job = seedPublishJob({ containerId: "c1" });
    let published = 0;
    store.graph = async ({ path, method }) => {
      if (method === "POST" && path.endsWith("/media_publish")) {
        published++;
        return { id: "m1" };
      }
      controller.abort(); // the handler's budget expires while Meta is answering
      return { status_code: "FINISHED" };
    };

    await runPublishJob(job.id as string, controller.signal);

    expect(published).toBe(0);
    expect(job.status).not.toBe("FAILED"); // the retry decides, not the abandoned pass
  });

  it("hands the job to a fresh pass when the queue abandons this one", async () => {
    // An abandoned pass is the one loss with no successor: the queue left its
    // row RUNNING only until the handler returns, and then records that clean
    // return as COMPLETED, so recovery never revives it. Stopping here without
    // queueing anything strands the post in PROCESSING — a status neither retry
    // nor delete accepts, so nothing can ever move it again.
    const controller = new AbortController();
    const job = seedPublishJob({ containerId: "c1" });
    store.graph = async () => {
      controller.abort();
      return { status_code: "FINISHED" };
    };

    await runPublishJob(job.id as string, controller.signal);

    expect(job.startedAt).toBeNull(); // the lease is free for whoever runs next
    expect(pendingPasses()).toHaveLength(1);
    expect((pendingPasses()[0]!.runAt as Date).getTime()).toBeLessThanOrEqual(store.dbNow);

    store.graph = async ({ path, method }) => (method === "POST" && path.endsWith("/media_publish") ? { id: "m1" } : { status_code: "FINISHED" });
    await runPublishJob(job.id as string);
    expect(job.status).toBe("PUBLISHED"); // the post still goes out, exactly once
  });

  it("releases the job between passes so its own next poll can claim it", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    store.graph = async () => ({ status_code: "IN_PROGRESS" });

    await runPublishJob(job.id as string);

    expect(job.startedAt).toBeNull();
    expect(job.attempts).toBe(1);
    expect(queuedPasses()).toHaveLength(1);
    expect((queuedPasses()[0]!.runAt as Date).getTime()).toBeGreaterThanOrEqual(Date.now() + POLL_DELAY_MS - 50);

    store.graph = async ({ path, method }) => (method === "POST" && path.endsWith("/media_publish") ? { id: "m1" } : { status_code: "FINISHED" });
    await runPublishJob(job.id as string);
    expect(job.status).toBe("PUBLISHED");
  });
});

describe("a handler that outran its time budget", () => {
  const queueJob = (row: Row = {}): Row => {
    const seeded: Row = {
      id: "q1",
      type: "publish.run",
      payload: {},
      lane: "default",
      status: "RUNNING",
      priority: 5,
      attempts: 1,
      maxAttempts: 5,
      runAt: new Date(store.dbNow - 1000),
      lockedAt: new Date(store.dbNow),
      lockedBy: "w1",
      leaseExpiresAt: new Date(store.dbNow + 300_000),
      ...row,
    };
    store.jobs.push(seeded);
    return seeded;
  };

  afterEach(() => vi.useRealTimers());

  it("keeps its lease instead of being retried underneath the running handler", async () => {
    // Failing it here released the lock and put the job back seconds later, on
    // top of a handler still talking to Instagram — the double publish.
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let handlerSignal: AbortSignal | undefined;
    registerHandler("publish.run", async (_payload, _job, signal) => {
      handlerSignal = signal;
      await hung;
    });
    const row = queueJob();
    const runAt = row.runAt;

    const pass = processJob(row as unknown as Job, "w1");
    await vi.advanceTimersByTimeAsync(jobTimeoutMs("default") + 10);
    await pass;

    expect(handlerSignal?.aborted).toBe(true);
    expect(row.status).toBe("RUNNING"); // still leased: no other worker can claim it
    expect(row.lockedBy).toBe("w1");
    expect(row.runAt).toBe(runAt); // and no retry was scheduled

    finish?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(row.status).toBe("COMPLETED"); // its real outcome, once it came back
  });

  it("still fails a handler that genuinely returns an error", async () => {
    registerHandler("publish.run", async () => {
      throw new Error("boom");
    });
    const row = queueJob();

    await processJob(row as unknown as Job, "w1");

    expect(row.status).toBe("FAILED");
    expect(row.lockedBy).toBeNull();
    expect((row.runAt as Date).getTime()).toBeGreaterThan(Date.now());
  });

  it("reaches work that was called without a signal of its own", async () => {
    // queue/handlers.ts calls runPublishJob(id) and passes nothing else, so the
    // abort has to arrive through the running job's context — otherwise the pass
    // the queue walked away from carries on and publishes behind its retry.
    vi.useFakeTimers();
    const job = seedPublishJob({ containerId: "c1" });
    let published = 0;
    let answerMeta: (() => void) | undefined;
    const metaSilence = new Promise<void>((resolve) => {
      answerMeta = resolve;
    });
    store.graph = async ({ path, method }) => {
      if (method === "POST" && path.endsWith("/media_publish")) {
        published++;
        return { id: "m1" };
      }
      await metaSilence; // Meta says nothing until the budget is long gone
      return { status_code: "FINISHED" };
    };
    let pass: Promise<void> | undefined;
    registerHandler("publish.run", async (payload) => {
      pass = runPublishJob(String(payload.publishJobId));
      await pass;
    });
    const row = queueJob({ payload: { publishJobId: job.id } });

    const run = processJob(row as unknown as Job, "w1");
    await vi.advanceTimersByTimeAsync(jobTimeoutMs("default") + 10);
    await run;

    answerMeta?.();
    await pass;
    await vi.advanceTimersByTimeAsync(1);
    expect(published).toBe(0);
    expect(job.status).toBe("PROCESSING"); // left for the retry, not failed or published

    // The queue row is settled the instant the abandoned handler returns, so
    // recoverStaleJobs will never revive it: the pass the stopping pass queued
    // is the only thing left that can finish this post.
    expect(row.status).toBe("COMPLETED");
    expect(job.startedAt).toBeNull();
    expect(pendingPasses()).toHaveLength(1);
  });

  it("drops a late outcome when the job has already been given to another worker", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => {
      finish = resolve;
    });
    registerHandler("publish.run", async () => {
      await hung;
    });
    const row = queueJob();

    const pass = processJob(row as unknown as Job, "w1");
    await vi.advanceTimersByTimeAsync(jobTimeoutMs("default") + 10);
    await pass;

    // recovery handed the job on while the abandoned handler was still running
    Object.assign(row, { status: "RUNNING", lockedBy: "w2" });
    finish?.();
    await vi.advanceTimersByTimeAsync(1);

    expect(row.lockedBy).toBe("w2");
    expect(row.status).toBe("RUNNING"); // the abandoned pass wrote nothing
  });
});
