import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstagramAccount, Job } from "@prisma/client";
import {
  assertCanPublish,
  buildContainerParams,
  describePublishError,
  EARLY_WAKE_MARGIN_MS,
  extensionFor,
  fetchPublishingLimit,
  hostedMediaUrl,
  isJpeg,
  kindFromUrl,
  kindFromUrlOrNull,
  MAX_POLL_ATTEMPTS,
  parseContainerStatus,
  parsePublishingLimit,
  POLL_DELAY_MS,
  PUBLISH_PASS_LEASE_MS,
  PUBLISH_QUOTA_ERROR_CODE,
  publishRunKey,
  QUOTA_RETRY_DELAY_MS,
  RATE_LIMIT_RETRY_DELAY_MS,
  resolveItemKind,
  retryDelayForPublishError,
  runPublishJob,
  scheduleKey,
  schedulePublishJob,
  validatePublishInput,
  wakeKey,
  wakeRunAt,
} from "@/lib/meta/publishing";
import { fetchAccountInsights, fetchMediaInsights, insightMetricsFor, syncMedia } from "@/lib/meta/media";
import {
  ALLOWED_RESOURCE_MIME,
  MAX_RESOURCE_BYTES,
  contentDispositionFor,
  resourceExtensionFor,
  resourceKindFromMime,
  resourceUrlFor,
} from "@/lib/resources";
import { MetaApiError } from "@/lib/meta/client";
import { AppError, metaPermissionMissing, tokenExpired } from "@/lib/errors";
import {
  HEARTBEAT_INTERVAL_MS,
  backoffMs,
  claimNextJob,
  completeJob,
  drainOnce,
  enqueue,
  failJob,
  getHandler,
  heartbeatJob,
  jobTimeoutMs,
  laneForType,
  processJob,
  queueDepth,
  recoverStaleJobs,
  registerHandler,
} from "@/lib/queue";
import type { JobLane } from "@/lib/queue";
import type { AccountWithAuth } from "@/lib/meta/capabilities";

type Row = Record<string, unknown>;

interface GraphOpts {
  host: string;
  method?: string;
  path: string;
  accessToken: string;
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

/**
 * QA suite for publishing / media / the job queue.
 *
 * Everything below runs the REAL product code. Only the two things this
 * environment genuinely cannot have are stood in for:
 *
 *  - Postgres → an in-memory table set (the tests/video-render.test.ts pattern),
 *    plus a tiny interpreter for the ONE raw SQL statement the queue uses. That
 *    interpreter reads the conditions out of the product's own SQL string, so a
 *    clause deleted from claimNextJob stops being enforced here too and the
 *    lane / attempts tests fail — it cannot pass by agreeing with itself.
 *  - The Meta Graph API → a scripted responder; every request the product makes
 *    is recorded and asserted (method, path, body), so the protocol order
 *    (container → status → media_publish) is proven, not assumed.
 */
const { store, prismaMock, graphMock, graphPagedMock, resolveAccessMock } = vi.hoisted(() => {
  const store = {
    publishJobs: [] as Row[],
    jobs: [] as Row[],
    contentItems: [] as Row[],
    accountUpdates: [] as Row[],
    workerHeartbeats: [] as Row[],
    rawQueries: [] as Array<{ sql: string; values: unknown[] }>,
    graphCalls: [] as GraphOpts[],
    seq: 0,
    /** The database's clock. null = this process's. */
    dbNow: null as number | null,
    graph: (async () => ({})) as (opts: GraphOpts) => Promise<unknown>,
    paged: (async () => []) as (opts: GraphOpts, maxItems: number) => Promise<unknown[]>,
  };

  const dbNow = () => store.dbNow ?? Date.now();

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
        if ("gte" in c) return value instanceof Date && value.getTime() >= (c.gte as Date).getTime();
        if ("has" in c) return Array.isArray(value) && value.includes(c.has);
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
    findFirst: async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) => {
      let hit = rows.filter((r) => matches(r, where));
      if (orderBy && "runAt" in orderBy) {
        hit = [...hit].sort((a, b) => (a.runAt as Date).getTime() - (b.runAt as Date).getTime());
      }
      return hit[0] ? { ...hit[0] } : null;
    },
    findMany: async ({ where, take }: { where?: Row; take?: number } = {}) =>
      rows.filter((r) => matches(r, where)).slice(0, take ?? rows.length).map((r) => ({ ...r })),
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)).length,
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error("record not found");
      Object.assign(row, data, { updatedAt: new Date(dbNow()) });
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data, { updatedAt: new Date(dbNow()) });
      return { count: hit.length };
    },
    deleteMany: async ({ where }: { where?: Row } = {}) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) rows.splice(rows.indexOf(row), 1);
      return { count: hit.length };
    },
  });

  /**
   * Interprets claimNextJob's UPDATE … FOR UPDATE SKIP LOCKED against the
   * in-memory rows. Every filter is switched on by finding its clause in the
   * product's own SQL text, and the lane list / lease length come from the
   * bound parameters — so removing a clause from the product removes it here.
   */
  const execClaim = (sql: string, values: unknown[]): Row[] => {
    const now = dbNow();
    const workerId = String(values[0]);
    const leaseSecs = Number(values[1]);
    const lanes = (values[2] ?? []) as string[];

    const checks: Array<(j: Row) => boolean> = [];
    const statusIn = /status IN \(([^)]+)\)/.exec(sql);
    if (statusIn) {
      const allowed = statusIn[1]!.split(",").map((s) => s.trim().replace(/'/g, ""));
      checks.push((j) => allowed.includes(String(j.status)));
    }
    if (sql.includes('"runAt" <= NOW()')) checks.push((j) => (j.runAt as Date).getTime() <= now);
    if (/lane = ANY\(/.test(sql)) checks.push((j) => lanes.includes(String(j.lane ?? "default")));
    if (/attempts < "maxAttempts"/.test(sql)) checks.push((j) => Number(j.attempts) < Number(j.maxAttempts));

    let candidates = store.jobs.filter((j) => checks.every((c) => c(j)));
    if (/ORDER BY priority DESC, "runAt" ASC/.test(sql)) {
      candidates = [...candidates].sort(
        (a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0) || (a.runAt as Date).getTime() - (b.runAt as Date).getTime(),
      );
    }
    const row = candidates[0];
    if (!row) return [];
    if (/SET status = 'RUNNING'/.test(sql)) row.status = "RUNNING";
    if (/"lockedAt" = NOW\(\)/.test(sql)) row.lockedAt = new Date(now);
    if (/"lockedBy" = /.test(sql)) row.lockedBy = workerId;
    if (/"leaseExpiresAt" = NOW\(\) \+ make_interval/.test(sql)) row.leaseExpiresAt = new Date(now + leaseSecs * 1000);
    if (/attempts = attempts \+ 1/.test(sql)) row.attempts = Number(row.attempts) + 1;
    row.updatedAt = new Date(now);
    return [{ ...row }];
  };

  return {
    store,
    graphMock: vi.fn(async (opts: GraphOpts) => {
      store.graphCalls.push(opts);
      return store.graph(opts);
    }),
    graphPagedMock: vi.fn(async (opts: GraphOpts, maxItems: number) => {
      store.graphCalls.push(opts);
      return store.paged(opts, maxItems);
    }),
    resolveAccessMock: vi.fn(async () => ({ host: "graph.instagram.com", accessToken: "tok" })),
    prismaMock: {
      publishJob: table(
        store.publishJobs,
        (data) => ({ id: `pj${++store.seq}`, attempts: 0, childContainerIds: [], ...data }),
        (row, args) =>
          (args.include as Row | undefined)?.account
            ? { ...row, account: { id: "acc1", igUserId: "ig1", isDemo: false, connectionMode: "INSTAGRAM_LOGIN" } }
            : row,
      ),
      job: table(store.jobs, (data) => {
        if (data.idempotencyKey && store.jobs.some((j) => j.idempotencyKey === data.idempotencyKey)) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`idempotencyKey`)"), { code: "P2002" });
        }
        return {
          id: `q${++store.seq}`,
          status: "PENDING",
          attempts: 0,
          maxAttempts: 5,
          priority: 0,
          lane: "default",
          lockedAt: null,
          lockedBy: null,
          leaseExpiresAt: null,
          lastError: null,
          idempotencyKey: null,
          createdAt: new Date(dbNow()),
          updatedAt: new Date(dbNow()),
          ...data,
        };
      }),
      contentItem: {
        upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
          const key = where.accountId_mediaId as { accountId: string; mediaId: string };
          const existing = store.contentItems.find((r) => r.accountId === key.accountId && r.mediaId === key.mediaId);
          if (existing) {
            Object.assign(existing, update);
            return { ...existing };
          }
          const row: Row = { id: `ci${++store.seq}`, ...create };
          store.contentItems.push(row);
          return { ...row };
        },
      },
      instagramAccount: {
        update: async ({ where, data }: { where: Row; data: Row }) => {
          store.accountUpdates.push({ where, data });
          return { ...where, ...data };
        },
      },
      workerHeartbeat: {
        upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
          const existing = store.workerHeartbeats.find((r) => r.id === where.id);
          if (existing) {
            Object.assign(existing, update);
            return { ...existing };
          }
          const row: Row = { ...create };
          store.workerHeartbeats.push(row);
          return { ...row };
        },
        findMany: async () => store.workerHeartbeats.map((r) => ({ ...r })),
        count: async () => store.workerHeartbeats.length,
      },
      $queryRaw: async (strings: TemplateStringsArray | string[], ...values: unknown[]) => {
        const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
        store.rawQueries.push({ sql, values });
        if (/SELECT NOW\(\) AS now/i.test(sql)) return [{ now: new Date(dbNow()) }];
        if (/UPDATE "Job"/.test(sql)) return execClaim(sql, values);
        throw new Error(`unmocked raw query: ${sql}`);
      },
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  graphCall: graphMock,
  graphCallPaged: graphPagedMock,
}));

vi.mock("@/lib/meta/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/tokens")>()),
  resolveAccess: resolveAccessMock,
}));

const DB_NOW = Date.parse("2026-10-01T09:00:00Z");

beforeEach(() => {
  store.publishJobs.length = 0;
  store.jobs.length = 0;
  store.contentItems.length = 0;
  store.accountUpdates.length = 0;
  store.workerHeartbeats.length = 0;
  store.rawQueries.length = 0;
  store.graphCalls.length = 0;
  store.seq = 0;
  store.dbNow = DB_NOW;
  store.graph = async () => ({});
  store.paged = async () => [];
  graphMock.mockClear();
  graphPagedMock.mockClear();
  resolveAccessMock.mockClear();
  resolveAccessMock.mockImplementation(async () => ({ host: "graph.instagram.com", accessToken: "tok" }));
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------- helpers

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
    scheduledAt: new Date((store.dbNow ?? Date.now()) - 1000),
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

function seedQueueRow(row: Row = {}): Row {
  const seeded: Row = {
    id: `q-${store.jobs.length + 1}`,
    type: "publish.run",
    payload: {},
    lane: "default",
    status: "PENDING",
    priority: 0,
    attempts: 0,
    maxAttempts: 5,
    runAt: new Date((store.dbNow ?? Date.now()) - 1000),
    lockedAt: null,
    lockedBy: null,
    leaseExpiresAt: null,
    lastError: null,
    idempotencyKey: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...row,
  };
  store.jobs.push(seeded);
  return seeded;
}

/** A scripted Meta Graph API. Returns the responder store.graph is set to. */
function graphScript(cfg: {
  containers?: string[];
  status?: Record<string, unknown> | Array<Record<string, unknown>>;
  mediaId?: string;
  media?: Record<string, unknown>;
  limit?: Record<string, unknown>;
  onPublish?: () => void;
} = {}) {
  const containers = [...(cfg.containers ?? ["c1"])];
  const statuses = Array.isArray(cfg.status) ? [...cfg.status] : [cfg.status ?? { status_code: "FINISHED" }];
  const mediaId = cfg.mediaId ?? "m1";
  return async (o: GraphOpts): Promise<unknown> => {
    if (o.path.endsWith("/content_publishing_limit")) return cfg.limit ?? { data: [{ quota_usage: 1, config: { quota_total: 100 } }] };
    if (o.method === "POST" && o.path.endsWith("/media_publish")) {
      cfg.onPublish?.();
      return { id: mediaId };
    }
    if (o.method === "POST" && o.path.endsWith("/media")) return { id: containers.length > 1 ? containers.shift()! : containers[0]! };
    if (o.path === mediaId) return cfg.media ?? { id: mediaId, permalink: `https://www.instagram.com/p/${mediaId}/` };
    return statuses.length > 1 ? statuses.shift()! : statuses[0]!;
  };
}

const passes = () => store.jobs.filter((j) => j.type === "publish.run");
const pendingPasses = () => passes().filter((j) => j.status === "PENDING");
const posted = (path: string) => store.graphCalls.filter((c) => c.method === "POST" && c.path === path);
const account = (over: Row = {}) =>
  ({ id: "acc1", igUserId: "ig1", isDemo: false, connectionMode: "INSTAGRAM_LOGIN", ...over }) as unknown as InstagramAccount;

// ============================================================ PUBLISHING ===

describe("publish state machine: container → poll → media_publish", () => {
  it("runs the whole protocol in order for a photo post and records the result", async () => {
    const job = seedPublishJob({ caption: "Hello Namangan" });
    store.graph = graphScript({ containers: ["c_img"], status: { status_code: "FINISHED" }, mediaId: "m_img" });

    await runPublishJob(job.id as string);

    // 1) limit check, 2) container, 3) status poll, 4) publish, 5) read back
    expect(store.graphCalls.map((c) => `${c.method ?? "GET"} ${c.path}`)).toEqual([
      "GET ig1/content_publishing_limit",
      "POST ig1/media",
      "GET c_img",
      "POST ig1/media_publish",
      "GET m_img",
    ]);
    expect(posted("ig1/media")[0]!.body).toEqual({ image_url: "https://cdn.example.com/a.jpg", caption: "Hello Namangan" });
    expect(posted("ig1/media_publish")[0]!.body).toEqual({ creation_id: "c_img" });

    expect(job.status).toBe("PUBLISHED");
    expect(job.publishedMediaId).toBe("m_img");
    expect(job.permalink).toBe("https://www.instagram.com/p/m_img/");
    expect(job.lastError).toBeNull();
    expect(store.contentItems).toHaveLength(1);
    expect(store.contentItems[0]).toMatchObject({ accountId: "acc1", mediaId: "m_img", mediaProductType: "FEED" });
  });

  it("sends a Reel as media_type REELS with its video url, cover and share_to_feed", async () => {
    const job = seedPublishJob({
      mediaType: "REELS",
      items: [{ url: "https://cdn.example.com/clip.mp4", kind: "VIDEO" }],
      caption: "reel",
      shareToFeed: false,
      coverUrl: "https://cdn.example.com/cover.jpg",
    });
    store.graph = graphScript({ containers: ["c_reel"], mediaId: "m_reel" });

    await runPublishJob(job.id as string);

    expect(posted("ig1/media")[0]!.body).toEqual({
      media_type: "REELS",
      video_url: "https://cdn.example.com/clip.mp4",
      caption: "reel",
      share_to_feed: false,
      cover_url: "https://cdn.example.com/cover.jpg",
    });
    expect(job.status).toBe("PUBLISHED");
    expect(store.contentItems[0]).toMatchObject({ mediaProductType: "REELS" });
  });

  it("IN_PROGRESS parks a poll instead of publishing, and the next pass finishes it", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    store.graph = graphScript({ status: { status_code: "IN_PROGRESS" } });

    await runPublishJob(job.id as string);

    expect(posted("ig1/media_publish")).toHaveLength(0);
    expect(job.attempts).toBe(1);
    expect(job.startedAt).toBeNull(); // lease released for the next pass
    expect(job.status).toBe("PROCESSING");
    expect(pendingPasses()).toHaveLength(1);
    expect((pendingPasses()[0]!.runAt as Date).getTime()).toBe(DB_NOW + POLL_DELAY_MS);
    expect(pendingPasses()[0]!.idempotencyKey).toBe(publishRunKey(job.id as string, "poll:1"));

    store.graph = graphScript({ status: { status_code: "FINISHED" }, mediaId: "m9" });
    await runPublishJob(job.id as string);
    expect(job.status).toBe("PUBLISHED");
    expect(job.publishedMediaId).toBe("m9");
  });

  it("ERROR fails the job with Instagram's own explanation, and never publishes", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    store.graph = graphScript({ status: { status_code: "ERROR", status: "Error: Media aspect ratio invalid" } });

    await runPublishJob(job.id as string);

    expect(job.status).toBe("FAILED");
    expect(String(job.lastError)).toContain("Media aspect ratio invalid");
    expect(posted("ig1/media_publish")).toHaveLength(0);
    expect(pendingPasses()).toHaveLength(0); // nothing left spinning
  });

  it("EXPIRED fails the job and names the state Meta reported", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    store.graph = graphScript({ status: { status_code: "EXPIRED" } });

    await runPublishJob(job.id as string);

    expect(job.status).toBe("FAILED");
    expect(String(job.lastError)).toContain("EXPIRED");
    expect(posted("ig1/media_publish")).toHaveLength(0);
  });

  it("gives up after MAX_POLL_ATTEMPTS instead of polling forever", async () => {
    const job = seedPublishJob({ containerId: "c1", attempts: MAX_POLL_ATTEMPTS });
    store.graph = graphScript({ status: { status_code: "IN_PROGRESS" } });

    await runPublishJob(job.id as string);

    expect(job.status).toBe("FAILED");
    expect(String(job.lastError)).toMatch(/did not finish processing/i);
    expect(pendingPasses()).toHaveLength(0);
  });

  it("an UNKNOWN status_code is treated as still processing, not as success", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    store.graph = graphScript({ status: { status_code: "SOMETHING_NEW" } });

    await runPublishJob(job.id as string);

    expect(posted("ig1/media_publish")).toHaveLength(0);
    expect(job.status).toBe("PROCESSING");
    expect(job.attempts).toBe(1);
  });

  it("a container Meta already published is recorded, not published a second time", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    store.graph = graphScript({ status: { status_code: "PUBLISHED" } });

    await runPublishJob(job.id as string);

    expect(posted("ig1/media_publish")).toHaveLength(0);
    expect(job.status).toBe("PUBLISHED");
    expect(job.publishedMediaId).toBeNull(); // honest: live, media id unknown
  });

  it("carousel: children first, then the parent referencing them — and children are never re-created", async () => {
    const job = seedPublishJob({
      mediaType: "CAROUSEL",
      caption: "album",
      items: [
        { url: "https://cdn.example.com/1.jpg", kind: "IMAGE" },
        { url: "https://cdn.example.com/2.mp4", kind: "VIDEO" },
      ],
    });
    const created: string[] = [];
    const childStatus: Record<string, string> = { ch1: "IN_PROGRESS", ch2: "IN_PROGRESS" };
    store.graph = async (o) => {
      if (o.path.endsWith("/content_publishing_limit")) return { data: [{ quota_usage: 0, config: { quota_total: 100 } }] };
      if (o.method === "POST" && o.path.endsWith("/media_publish")) return { id: "m_car" };
      if (o.method === "POST" && o.path.endsWith("/media")) {
        const id = (o.body as Row).is_carousel_item ? `ch${created.filter((c) => c.startsWith("ch")).length + 1}` : "parent";
        created.push(id);
        return { id };
      }
      if (o.path === "m_car") return { id: "m_car", permalink: "https://www.instagram.com/p/m_car/" };
      if (o.path === "parent") return { status_code: "FINISHED" };
      return { status_code: childStatus[o.path] ?? "FINISHED" };
    };

    // pass 1: children created, still processing → parked
    await runPublishJob(job.id as string);
    expect(created).toEqual(["ch1", "ch2"]);
    expect(job.childContainerIds).toEqual(["ch1", "ch2"]);
    expect(job.containerId).toBeNull();
    expect(job.attempts).toBe(1);

    // pass 2: children finished → parent container → publish
    childStatus.ch1 = "FINISHED";
    childStatus.ch2 = "FINISHED";
    await runPublishJob(job.id as string);

    expect(created).toEqual(["ch1", "ch2", "parent"]); // no duplicate children
    expect(posted("ig1/media").at(-1)!.body).toEqual({ media_type: "CAROUSEL", children: "ch1,ch2", caption: "album" });
    expect(job.status).toBe("PUBLISHED");
    expect(job.publishedMediaId).toBe("m_car");
  });

  it("a carousel item Instagram rejects fails the whole post", async () => {
    const job = seedPublishJob({
      mediaType: "CAROUSEL",
      items: [
        { url: "https://cdn.example.com/1.jpg", kind: "IMAGE" },
        { url: "https://cdn.example.com/2.jpg", kind: "IMAGE" },
      ],
      childContainerIds: ["ch1", "ch2"],
    });
    store.graph = async (o) => (o.path === "ch1" ? { status_code: "ERROR", status: "Error: file too large" } : { status_code: "FINISHED" });

    await runPublishJob(job.id as string);

    expect(job.status).toBe("FAILED");
    expect(String(job.lastError)).toContain("file too large");
    expect(posted("ig1/media")).toHaveLength(0);
  });

  it("the quota is checked only when containers are created, not on every poll", async () => {
    const polling = seedPublishJob({ containerId: "c1" });
    store.graph = graphScript({ status: { status_code: "IN_PROGRESS" } });
    await runPublishJob(polling.id as string);
    expect(store.graphCalls.some((c) => c.path.endsWith("/content_publishing_limit"))).toBe(false);
  });
});

describe("a token that no longer works", () => {
  it("fails the job with a readable reason instead of leaving it SCHEDULED", async () => {
    const job = seedPublishJob();
    resolveAccessMock.mockImplementation(async () => {
      throw tokenExpired();
    });

    await runPublishJob(job.id as string);

    expect(job.status).toBe("FAILED");
    expect(job.status).not.toBe("SCHEDULED");
    expect(String(job.lastError)).toMatch(/token expired or was revoked/i);
    // DEFECT (fixed): describePublishError kept the "how to fix it" line for a
    // MetaApiError but dropped it for a plain AppError — and an expired token is
    // exactly that, because resolveAccess throws before any Graph call. The
    // failed post told the admin what broke and never that reconnecting fixes it.
    expect(String(job.lastError)).toMatch(/Settings → Integrations → Instagram/);
    expect(store.graphCalls).toHaveLength(0);
  });

  it("a missing publishing permission also reaches the admin with its fix", async () => {
    const job = seedPublishJob();
    resolveAccessMock.mockImplementation(async () => {
      throw metaPermissionMissing("instagram_business_content_publish");
    });

    await runPublishJob(job.id as string);

    expect(job.status).toBe("FAILED");
    expect(String(job.lastError)).toContain("instagram_business_content_publish");
    expect(String(job.lastError)).toMatch(/approve all requested permissions/i);
  });

  it("fails visibly on a Meta token error raised mid-flight (code 190), with no retry queued", async () => {
    const job = seedPublishJob();
    store.graph = async (o) => {
      if (o.path.endsWith("/content_publishing_limit")) return { data: [{ quota_usage: 0 }] };
      throw new MetaApiError({ message: "Session expired", code: 190 }, 401);
    };

    await runPublishJob(job.id as string);

    expect(job.status).toBe("FAILED");
    expect(String(job.lastError)).toMatch(/expired/i);
    expect(pendingPasses()).toHaveLength(0);
  });

  it("a publishing-limit lookup that fails never blocks the post", async () => {
    const job = seedPublishJob();
    store.graph = async (o) => {
      if (o.path.endsWith("/content_publishing_limit")) throw new MetaApiError({ message: "boom", code: 100 }, 400);
      if (o.method === "POST" && o.path.endsWith("/media_publish")) return { id: "m1" };
      if (o.method === "POST" && o.path.endsWith("/media")) return { id: "c1" };
      if (o.path === "m1") return { id: "m1", permalink: "p" };
      return { status_code: "FINISHED" };
    };

    await runPublishJob(job.id as string);

    expect(job.status).toBe("PUBLISHED");
    expect(await fetchPublishingLimit(account())).toBeNull(); // and the helper itself stays quiet
  });
});

describe("the cancel race", () => {
  it("a cancel landing after media_publish is not overwritten with PUBLISHED", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    store.graph = graphScript({
      mediaId: "m_live",
      onPublish: () => {
        job.status = "CANCELLED"; // the admin cancels while Instagram is answering
      },
    });

    await runPublishJob(job.id as string);

    expect(job.status).toBe("CANCELLED");
    expect(job.publishedMediaId).toBe("m_live"); // but the truth is recorded
    expect(String(job.lastError)).toMatch(/Cancelled too late/i);
    expect(String(job.lastError)).toMatch(/Delete it in the Instagram app/i);
  });

  it("a cancel landing before the publish call stops the post going out at all", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    let published = 0;
    store.graph = async (o) => {
      if (o.method === "POST" && o.path.endsWith("/media_publish")) {
        published++;
        return { id: "m1" };
      }
      job.status = "CANCELLED"; // cancelled while the status poll is in flight
      return { status_code: "FINISHED" };
    };

    await runPublishJob(job.id as string);

    expect(published).toBe(0);
    expect(job.status).toBe("CANCELLED");
    expect(job.publishedMediaId).toBeNull();
  });

  it("a cancel before the container is created stops it before anything irreversible", async () => {
    const job = seedPublishJob({
      mediaType: "CAROUSEL",
      items: [
        { url: "https://cdn.example.com/1.jpg", kind: "IMAGE" },
        { url: "https://cdn.example.com/2.jpg", kind: "IMAGE" },
      ],
    });
    store.graph = async (o) => {
      if (o.path.endsWith("/content_publishing_limit")) {
        job.status = "CANCELLED";
        return { data: [{ quota_usage: 0 }] };
      }
      return { id: "should-not-happen" };
    };

    await runPublishJob(job.id as string);

    expect(posted("ig1/media")).toHaveLength(0);
    expect(job.status).toBe("CANCELLED");
  });

  it("a cancelled job is not picked up by a later pass at all", async () => {
    const job = seedPublishJob({ status: "CANCELLED" });
    store.graph = graphScript({});

    await runPublishJob(job.id as string);

    expect(store.graphCalls).toHaveLength(0);
    expect(job.status).toBe("CANCELLED");
  });
});

describe("waking early, on the database's clock", () => {
  it("re-queues a real sleep even when the database clock runs two minutes ahead", async () => {
    vi.useFakeTimers();
    const localNow = Date.parse("2026-10-01T09:00:00Z");
    vi.setSystemTime(new Date(localNow));
    store.dbNow = localNow + 2 * 60_000; // the database is 2 minutes ahead of this worker
    const job = seedPublishJob({ scheduledAt: new Date(store.dbNow + 90_000) });

    await runPublishJob(job.id as string);

    expect(store.graphCalls).toHaveLength(0);
    expect(pendingPasses()).toHaveLength(1);
    const parked = pendingPasses()[0]!;

    // measured on the DB clock, which is the clock claimNextJob compares runAt to
    expect((parked.runAt as Date).getTime()).toBe(store.dbNow + EARLY_WAKE_MARGIN_MS);
    expect((parked.runAt as Date).getTime()).toBeGreaterThan(store.dbNow);
    // the same margin on THIS process's clock would have been no wait at all
    expect(Date.now() + EARLY_WAKE_MARGIN_MS).toBeLessThanOrEqual(store.dbNow);

    const key = String(parked.idempotencyKey);
    expect(key).not.toBe(scheduleKey({ id: job.id as string, scheduledAt: job.scheduledAt as Date }));
    expect(key).toBe(wakeKey({ id: job.id as string, scheduledAt: job.scheduledAt as Date }, store.dbNow));
    expect(key).not.toBe(wakeKey({ id: job.id as string, scheduledAt: job.scheduledAt as Date }, Date.now()));
    expect(job.status).toBe("SCHEDULED"); // untouched, still waiting
  });

  it("the parked row then actually publishes when its time comes", async () => {
    const job = seedPublishJob({ scheduledAt: new Date(DB_NOW + 90_000) });
    await runPublishJob(job.id as string);
    const parked = pendingPasses()[0]!;

    store.dbNow = (parked.runAt as Date).getTime() + 60_000; // time passes; the row is claimed
    store.graph = graphScript({ mediaId: "m_late" });
    await runPublishJob(job.id as string);

    expect(job.status).toBe("PUBLISHED");
    expect(job.publishedMediaId).toBe("m_late");
  });

  it("re-queues under a fresh key when the key it derives belongs to a spent row", async () => {
    const job = seedPublishJob({ scheduledAt: new Date(DB_NOW + 3 * 60_000) });
    const key = wakeKey({ id: job.id as string, scheduledAt: job.scheduledAt as Date }, DB_NOW);
    seedQueueRow({ idempotencyKey: key, status: "COMPLETED", attempts: 1, maxAttempts: 3 });

    await runPublishJob(job.id as string);

    expect(pendingPasses()).toHaveLength(1);
    expect(pendingPasses()[0]!.idempotencyKey).not.toBe(key);
    expect(String(pendingPasses()[0]!.idempotencyKey).startsWith(key)).toBe(true);
  });

  it("does not queue a second copy when the key's owner is still going to run", async () => {
    const job = seedPublishJob({ scheduledAt: new Date(DB_NOW + 3 * 60_000) });
    const key = wakeKey({ id: job.id as string, scheduledAt: job.scheduledAt as Date }, DB_NOW);
    const live = seedQueueRow({ idempotencyKey: key, status: "PENDING", attempts: 0, maxAttempts: 3 });

    await runPublishJob(job.id as string);

    expect(pendingPasses()).toHaveLength(1);
    expect(pendingPasses()[0]!.id).toBe(live.id);
  });

  it("schedulePublishJob queues the post under its schedule key, once", async () => {
    const job = { id: "pj_x", scheduledAt: new Date(DB_NOW + 3600_000) };
    await schedulePublishJob(job);
    await schedulePublishJob(job); // a second save of the same schedule

    expect(passes()).toHaveLength(1);
    expect(passes()[0]!.idempotencyKey).toBe(scheduleKey(job));
    expect((passes()[0]!.runAt as Date).getTime()).toBe(job.scheduledAt.getTime());
  });

  it("wakeRunAt leaves a genuinely distant schedule alone and floors a near one", () => {
    const far = new Date(DB_NOW + 3600_000);
    expect(wakeRunAt(far, DB_NOW)).toBe(far);
    expect(wakeRunAt(new Date(DB_NOW + 1000), DB_NOW).getTime()).toBe(DB_NOW + EARLY_WAKE_MARGIN_MS);
  });
});

describe("one pass at a time", () => {
  it("a second pass parks behind the holder's lease instead of running", async () => {
    const heldSince = new Date(DB_NOW - 60_000);
    const job = seedPublishJob({ status: "PROCESSING", startedAt: heldSince, containerId: "c1" });
    store.graph = graphScript({});

    await runPublishJob(job.id as string);

    expect(store.graphCalls).toHaveLength(0);
    expect(job.startedAt).toBe(heldSince);
    expect(pendingPasses()).toHaveLength(1);
    expect((pendingPasses()[0]!.runAt as Date).getTime()).toBe(heldSince.getTime() + PUBLISH_PASS_LEASE_MS);
  });

  it("takes over once the holder's lease has lapsed", async () => {
    const job = seedPublishJob({ status: "PROCESSING", startedAt: new Date(DB_NOW - PUBLISH_PASS_LEASE_MS - 1), containerId: "c1" });
    store.graph = graphScript({ mediaId: "m1" });

    await runPublishJob(job.id as string);

    expect(job.status).toBe("PUBLISHED");
  });

  it("an abandoned pass stops before publishing and hands the job on", async () => {
    const controller = new AbortController();
    const job = seedPublishJob({ containerId: "c1" });
    let published = 0;
    store.graph = async (o) => {
      if (o.method === "POST" && o.path.endsWith("/media_publish")) {
        published++;
        return { id: "m1" };
      }
      controller.abort();
      return { status_code: "FINISHED" };
    };

    await runPublishJob(job.id as string, controller.signal);

    expect(published).toBe(0);
    expect(job.status).not.toBe("FAILED");
    expect(job.startedAt).toBeNull();
    expect(pendingPasses()).toHaveLength(1);
  });

  it("a pass whose lease was taken over mid-call writes nothing", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    let published = 0;
    store.graph = async (o) => {
      if (o.method === "POST" && o.path.endsWith("/media_publish")) {
        published++;
        return { id: "m1" };
      }
      job.startedAt = new Date(DB_NOW + 5_000); // a later pass claimed it
      return { status_code: "FINISHED" };
    };

    await runPublishJob(job.id as string);

    expect(published).toBe(0);
    expect(job.status).toBe("PROCESSING");
  });
});

describe("publishing quota and Meta's 'not now' answers", () => {
  it("a full 24h window parks the post with an explanation instead of failing it", async () => {
    const job = seedPublishJob();
    store.graph = graphScript({ limit: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } });

    await runPublishJob(job.id as string);

    expect(posted("ig1/media")).toHaveLength(0);
    expect(job.status).toBe("PROCESSING");
    expect(job.status).not.toBe("FAILED");
    expect(String(job.lastError)).toMatch(/publishing limit is full \(100\/100/);
    expect(job.attempts).toBe(1);
    expect(job.startedAt).toBeNull();
    expect(pendingPasses()).toHaveLength(1);
    expect((pendingPasses()[0]!.runAt as Date).getTime()).toBe(DB_NOW + QUOTA_RETRY_DELAY_MS);
    expect(pendingPasses()[0]!.idempotencyKey).toBe(publishRunKey(job.id as string, "quota:1"));
  });

  it("Meta error code 9 raised by the publish call is retryable, not fatal", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    store.graph = async (o) => {
      if (o.method === "POST" && o.path.endsWith("/media_publish")) {
        throw new MetaApiError({ message: "The user is temporarily blocked from publishing", code: PUBLISH_QUOTA_ERROR_CODE }, 400);
      }
      return { status_code: "FINISHED" };
    };

    await runPublishJob(job.id as string);

    expect(job.status).toBe("PROCESSING");
    expect(String(job.lastError)).toMatch(/24-hour publishing limit/i);
    expect(pendingPasses()).toHaveLength(1);
    expect((pendingPasses()[0]!.runAt as Date).getTime()).toBe(DB_NOW + QUOTA_RETRY_DELAY_MS);
  });

  it("a plain rate limit backs off on the shorter delay", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    store.graph = async () => {
      throw new MetaApiError({ message: "Application request limit reached", code: 4 }, 429);
    };

    await runPublishJob(job.id as string);

    expect(job.status).toBe("PROCESSING");
    expect(String(job.lastError)).toMatch(/slow down/i);
    expect((pendingPasses()[0]!.runAt as Date).getTime()).toBe(DB_NOW + RATE_LIMIT_RETRY_DELAY_MS);
    expect(pendingPasses()[0]!.idempotencyKey).toBe(publishRunKey(job.id as string, "rl:1"));
  });

  it("an ordinary Meta error is final for this post", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    store.graph = async () => {
      throw new MetaApiError({ message: "Invalid parameter", code: 100, error_user_msg: "The video format is not supported." }, 400);
    };

    await runPublishJob(job.id as string);

    expect(job.status).toBe("FAILED");
    expect(String(job.lastError)).toMatch(/video format is not supported/);
    expect(pendingPasses()).toHaveLength(0);
  });

  it("stops waiting for the quota after MAX_POLL_ATTEMPTS", async () => {
    const job = seedPublishJob({ attempts: MAX_POLL_ATTEMPTS });
    store.graph = graphScript({ limit: { data: [{ quota_usage: 100, config: { quota_total: 100 } }] } });

    await runPublishJob(job.id as string);

    expect(job.status).toBe("FAILED");
    expect(String(job.lastError)).toMatch(/Gave up after 40 attempts/);
  });

  it("retryDelayForPublishError classifies each answer", () => {
    expect(retryDelayForPublishError(new MetaApiError({ message: "x", code: PUBLISH_QUOTA_ERROR_CODE }, 400))).toBe(QUOTA_RETRY_DELAY_MS);
    expect(retryDelayForPublishError(new MetaApiError({ message: "x", code: 4 }, 429))).toBe(RATE_LIMIT_RETRY_DELAY_MS);
    expect(retryDelayForPublishError(new MetaApiError({ message: "x", code: 80001 }, 429))).toBe(RATE_LIMIT_RETRY_DELAY_MS);
    expect(retryDelayForPublishError(new MetaApiError({ message: "x", code: 190 }, 401))).toBeNull();
    expect(retryDelayForPublishError(new AppError("META_API_ERROR", "x"))).toBeNull();
    expect(retryDelayForPublishError(new Error("boom"))).toBeNull();
  });

  it("parsePublishingLimit reads Meta's shape and defaults the total to 100", () => {
    expect(parsePublishingLimit({ data: [{ quota_usage: 7, config: { quota_total: 50 } }] })).toEqual({ used: 7, quota: 50 });
    expect(parsePublishingLimit({ data: [{ quota_usage: 3 }] })).toEqual({ used: 3, quota: 100 });
    expect(parsePublishingLimit({ data: [{ quota_usage: "nope" }] })).toBeNull();
    expect(parsePublishingLimit({})).toBeNull();
  });
});

describe("what is refused before Meta is ever called", () => {
  const img = { url: "https://cdn.example.com/a.jpg", kind: "IMAGE" as const };
  const vid = { url: "https://cdn.example.com/a.mp4", kind: "VIDEO" as const };

  it("enforces kind, count, scheme, caption length and the schedule window", () => {
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img] })).toBeNull();
    expect(validatePublishInput({ mediaType: "IMAGE", items: [vid] })).toMatch(/image/);
    expect(validatePublishInput({ mediaType: "REELS", items: [img] })).toMatch(/video/);
    expect(validatePublishInput({ mediaType: "CAROUSEL", items: [img] })).toMatch(/2–10/);
    expect(validatePublishInput({ mediaType: "IMAGE", items: [{ url: "http://x/a.jpg", kind: "IMAGE" }] })).toMatch(/https/);
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], caption: "x".repeat(2201) })).toMatch(/2200/);
    const now = new Date("2026-09-12T12:00:00Z");
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], scheduledAt: new Date("2026-09-12T11:00:00Z"), now })).toMatch(/past/);
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], scheduledAt: new Date("2026-12-31T00:00:00Z"), now })).toMatch(/75 days/);
  });

  it("assertCanPublish refuses a demo account and a missing permission, per connection mode", () => {
    const base = {
      id: "acc1",
      igUserId: "ig1",
      isDemo: false,
      connectionMode: "INSTAGRAM_LOGIN",
      permissions: [],
      tokens: [{ kind: "user", status: "ACTIVE", scopes: ["instagram_business_content_publish"], expiresAt: null, issuedAt: new Date() }],
    } as unknown as AccountWithAuth;

    expect(() => assertCanPublish(base)).not.toThrow();
    expect(() => assertCanPublish({ ...base, isDemo: true } as AccountWithAuth)).toThrow(/Demo account cannot publish/);

    const noScope = { ...base, tokens: [{ kind: "user", status: "ACTIVE", scopes: [], expiresAt: null, issuedAt: new Date() }] } as unknown as AccountWithAuth;
    expect(() => assertCanPublish(noScope)).toThrow(/instagram_business_content_publish/);

    const facebook = {
      ...base,
      connectionMode: "FACEBOOK_LOGIN",
      tokens: [{ kind: "page", status: "ACTIVE", scopes: [], expiresAt: null, issuedAt: new Date() }],
    } as unknown as AccountWithAuth;
    expect(() => assertCanPublish(facebook)).toThrow(/instagram_content_publish/);
  });

  it("builds exactly the container parameters each media type needs", () => {
    expect(buildContainerParams({ mediaType: "IMAGE", items: [img], caption: "  hi  " }).main([])).toEqual({ image_url: img.url, caption: "hi" });
    expect(buildContainerParams({ mediaType: "STORIES", items: [vid] }).main([])).toEqual({ media_type: "STORIES", video_url: vid.url });
    expect(buildContainerParams({ mediaType: "STORIES", items: [img], caption: "ignored" }).main([])).toEqual({
      media_type: "STORIES",
      image_url: img.url,
    });
    const carousel = buildContainerParams({ mediaType: "CAROUSEL", items: [img, vid] });
    expect(carousel.children).toEqual([
      { is_carousel_item: true, image_url: img.url },
      { is_carousel_item: true, media_type: "VIDEO", video_url: vid.url },
    ]);
  });

  it("reads Meta's container status answers", () => {
    expect(parseContainerStatus({ status_code: "finished" })).toEqual({ code: "FINISHED", message: null });
    expect(parseContainerStatus({ status_code: "ERROR", status: " boom " })).toEqual({ code: "ERROR", message: "boom" });
    expect(parseContainerStatus({}).code).toBe("UNKNOWN");
  });

  it("explains errors in one admin-readable line", () => {
    const err = new MetaApiError({ message: "Invalid parameter", code: 100, error_user_msg: "The image is too small." }, 400);
    expect(describePublishError(err)).toMatch(/image is too small/);
    expect(describePublishError(new Error("plain"))).toBe("plain");
    expect(describePublishError("string error")).toBe("string error");
  });
});

describe("media kind inference", () => {
  const signed = "https://cdn.example.com/assets/9f2b?Expires=1&Signature=abc"; // no extension

  it("fills an extension-less URL in from the chosen media type", () => {
    expect(resolveItemKind("REELS", signed)).toBe("VIDEO");
    expect(resolveItemKind("IMAGE", signed)).toBe("IMAGE");
    expect(kindFromUrlOrNull(signed)).toBeNull();
    expect(kindFromUrl(signed)).toBe("IMAGE"); // the old heuristic alone, kept as a fallback
  });

  it("honours an explicit kind where both kinds are legal", () => {
    expect(resolveItemKind("STORIES", signed, "VIDEO")).toBe("VIDEO");
    expect(resolveItemKind("CAROUSEL", signed, "VIDEO")).toBe("VIDEO");
    expect(resolveItemKind("STORIES", signed)).toBe("IMAGE");
    expect(resolveItemKind("STORIES", signed, null)).toBe("IMAGE");
  });

  it("ignores an explicit kind the media type already settles", () => {
    expect(resolveItemKind("REELS", signed, "IMAGE")).toBe("VIDEO");
    expect(resolveItemKind("IMAGE", signed, "VIDEO")).toBe("IMAGE");
  });

  it("keeps a contradicting extension so the mismatch is refused up front", () => {
    expect(resolveItemKind("IMAGE", "https://x/a.mp4", "VIDEO")).toBe("VIDEO");
    expect(validatePublishInput({ mediaType: "IMAGE", items: [{ url: "https://x/a.mp4", kind: resolveItemKind("IMAGE", "https://x/a.mp4") }] })).toMatch(/image/);
  });

  it("reads a format only from a real extension", () => {
    expect(kindFromUrlOrNull("https://x/clip.MOV?sig=1")).toBe("VIDEO");
    expect(kindFromUrlOrNull("https://x/photo.webp#frag")).toBe("IMAGE");
    expect(kindFromUrlOrNull("https://x/a.bin")).toBeNull();
    expect(kindFromUrlOrNull("https://cdn.example.com")).toBeNull();
  });

  it("only ever produces a kind validatePublishInput then accepts", () => {
    for (const mediaType of ["IMAGE", "REELS", "STORIES"] as const) {
      expect(validatePublishInput({ mediaType, items: [{ url: signed, kind: resolveItemKind(mediaType, signed) }] })).toBeNull();
    }
  });

  it("hosted asset URLs carry the extension Meta expects", () => {
    expect(hostedMediaUrl("abc", "image/jpeg")).toBe("http://localhost:3000/m/abc.jpg");
    expect(extensionFor("video/quicktime")).toBe("mov");
    expect(extensionFor("image/png")).toBe("bin"); // publishing takes JPEG only
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isJpeg(new Uint8Array([0xff, 0xd8]))).toBe(false);
  });
});

// ================================================================ MEDIA ===

describe("insights metric sets", () => {
  it("never asks a story for metrics a story does not have", () => {
    const story = insightMetricsFor("STORY");
    expect(story.split(",")).toEqual(["views", "reach", "replies", "total_interactions"]);
    for (const feedOnly of ["likes", "comments", "shares", "saved"]) expect(story).not.toContain(feedOnly);
    expect(insightMetricsFor("STORIES")).toBe(story);
    expect(insightMetricsFor("story")).toBe(story);
  });

  it("keeps the reel and feed sets distinct", () => {
    expect(insightMetricsFor("REELS").split(",")).toEqual(["views", "reach", "likes", "comments", "shares", "saved", "total_interactions"]);
    expect(insightMetricsFor("FEED").split(",")).toEqual(["views", "reach", "likes", "comments", "shares", "saved"]);
    expect(insightMetricsFor(null)).toBe(insightMetricsFor("FEED"));
    expect(insightMetricsFor(undefined)).toBe(insightMetricsFor("FEED"));
    expect(insightMetricsFor("REELS")).not.toBe(insightMetricsFor("FEED"));
  });

  it("asks Meta for exactly that set, per media product type", async () => {
    store.graph = async () => ({ data: [{ name: "views", values: [{ value: 12 }] }] });

    await fetchMediaInsights(account(), "media_1", "STORY");
    expect(String(store.graphCalls[0]!.params!.metric)).toBe(insightMetricsFor("STORY"));
    expect(String(store.graphCalls[0]!.params!.metric)).not.toContain("likes");
    expect(store.graphCalls[0]!.path).toBe("media_1/insights");

    await fetchMediaInsights(account(), "media_2", "FEED");
    expect(String(store.graphCalls[1]!.params!.metric)).toContain("likes");
  });

  it("maps total_value and values, and reports emptiness as a failure rather than zeros", async () => {
    store.graph = async () => ({
      data: [
        { name: "views", total_value: { value: 500 } },
        { name: "reach", values: [{ value: 400 }] },
        { name: "likes" },
      ],
    });
    const ok = await fetchMediaInsights(account(), "m1", "FEED");
    expect(ok).toEqual({ ok: true, metrics: { views: 500, reach: 400, likes: 0 } });

    store.graph = async () => ({ data: [] });
    const empty = await fetchMediaInsights(account(), "m1", "FEED");
    expect(empty.ok).toBe(false);
    expect(empty.ok === false && empty.reason).toMatch(/no insight metrics/i);
  });

  it("turns a Meta failure into a reason instead of throwing", async () => {
    store.graph = async () => {
      throw new MetaApiError({ message: "Invalid metric", code: 100, error_user_msg: "This metric is not supported." }, 400);
    };
    const res = await fetchMediaInsights(account(), "m1", "STORY");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toMatch(/not supported/i);
  });

  it("account insights ask for the views-era metric set and total_value", async () => {
    store.graph = async () => ({ data: [{ name: "views", total_value: { value: 9 } }, { name: "reach", values: [{ value: 2 }, { value: 3 }] }] });
    const res = await fetchAccountInsights(account(), 7);
    expect(res).toEqual({ views: 9, reach: 5 });
    const params = store.graphCalls[0]!.params!;
    expect(String(params.metric)).not.toContain("impressions"); // deprecated by Meta
    expect(params.metric_type).toBe("total_value");
    expect(Number(params.until) - Number(params.since)).toBe(7 * 86400);
  });

  it("account insights return null rather than throwing when Meta refuses", async () => {
    store.graph = async () => {
      throw new MetaApiError({ message: "nope", code: 100 }, 400);
    };
    expect(await fetchAccountInsights(account())).toBeNull();
  });
});

describe("syncMedia", () => {
  it("stores every item it pages through and stamps the sync time", async () => {
    store.paged = async () => [
      { id: "ig_1", media_type: "IMAGE", media_product_type: "FEED", caption: "one", permalink: "p1", timestamp: "2026-09-01T10:00:00+0000", like_count: 3, comments_count: 1 },
      { id: "ig_2", media_type: "VIDEO", media_product_type: "REELS", permalink: "p2" },
    ];

    const n = await syncMedia(account(), 50);

    expect(n).toBe(2);
    expect(store.contentItems.map((r) => r.mediaId)).toEqual(["ig_1", "ig_2"]);
    expect(store.contentItems[0]).toMatchObject({ mediaProductType: "FEED", likeCount: 3, caption: "one" });
    expect((store.contentItems[0]!.timestamp as Date).toISOString()).toBe("2026-09-01T10:00:00.000Z");
    expect(store.accountUpdates).toHaveLength(1);
    expect((store.accountUpdates[0]!.data as Row).lastSyncAt).toBeInstanceOf(Date);
    const opts = store.graphCalls[0]!;
    expect(opts.path).toBe("ig1/media");
    expect(String(opts.params!.fields)).toContain("media_product_type");
  });

  it("updates an item it already has instead of duplicating it", async () => {
    store.paged = async () => [{ id: "ig_1", media_type: "IMAGE", like_count: 1, permalink: "p" }];
    await syncMedia(account(), 50);
    store.paged = async () => [{ id: "ig_1", media_type: "IMAGE", like_count: 42, permalink: "p" }];
    await syncMedia(account(), 50);

    expect(store.contentItems).toHaveLength(1);
    expect(store.contentItems[0]!.likeCount).toBe(42);
    expect(store.contentItems[0]!.syncedAt).toBeInstanceOf(Date);
  });
});

// ============================================================ RESOURCES ===

describe("comment resources", () => {
  it("keeps a Cyrillic file name readable AND the header valid", () => {
    const name = "Прайс-лист 2026.pdf";
    const header = contentDispositionFor(name);

    expect(header).toMatch(/^[\x20-\x7e]*$/); // Latin-1 safe
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe(name);
    // the real failure this guards: a raw UTF-8 header value throws in the
    // Response constructor, so /r/{id} answered 500 for the whole file
    expect(() => new Response(null, { headers: { "Content-Disposition": `inline; filename="${name}"` } })).toThrow();
    expect(() => new Response(null, { headers: { "Content-Disposition": header } })).not.toThrow();
  });

  it("does the same for Uzbek names with oʻ / gʻ and apostrophes", () => {
    for (const name of ["Oʻquv qoʻllanma.pdf", "Toshkent narx-navo roʻyxati.docx", "Bahosi — 1'200'000 soʻm.pdf"]) {
      const header = contentDispositionFor(name, "attachment");
      expect(header).toMatch(/^attachment; /);
      expect(header).toMatch(/^[\x20-\x7e]*$/);
      expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe(name);
      expect(() => new Response(null, { headers: { "Content-Disposition": header } })).not.toThrow();
    }
  });

  it("percent-encodes what RFC 5987 does not allow in filename*", () => {
    const encoded = contentDispositionFor("o'brien (final)*.pdf").split("filename*=UTF-8''")[1]!;
    expect(encoded).not.toMatch(/['()*!]/);
    expect(decodeURIComponent(encoded)).toBe("o'brien (final)*.pdf");
  });

  it("cannot be used to inject a second header, and never produces an empty name", () => {
    const nasty = contentDispositionFor('a"\r\nX-Evil: 1.pdf');
    expect(nasty).not.toMatch(/[\r\n]/);
    expect(nasty).toContain('filename="a___X-Evil: 1.pdf"');
    expect(() => new Response(null, { headers: { "Content-Disposition": nasty } })).not.toThrow();
    expect(contentDispositionFor("   ")).toBe(`inline; filename="file"; filename*=UTF-8''file`);
    expect(contentDispositionFor("Ω")).toContain('filename="_"');
  });

  it("classifies what Instagram can attach and what must be sent as a link", () => {
    expect(resourceKindFromMime("image/webp")).toBe("IMAGE");
    expect(resourceKindFromMime("video/quicktime")).toBe("VIDEO");
    expect(resourceKindFromMime("application/pdf")).toBe("FILE");
    expect(resourceKindFromMime("application/zip")).toBe("FILE");
  });

  it("serves resources from the app's own origin with a real extension", () => {
    expect(resourceUrlFor("res_1", "application/pdf")).toBe("http://localhost:3000/r/res_1.pdf");
    expect(resourceExtensionFor("video/quicktime")).toBe("mov");
    expect(resourceExtensionFor("application/octet-stream")).toBe("bin");
    expect(ALLOWED_RESOURCE_MIME.has("application/x-msdownload")).toBe(false);
    expect(MAX_RESOURCE_BYTES).toBe(4 * 1024 * 1024);
  });
});

// ================================================================ QUEUE ===

describe("queue lanes", () => {
  it("routes video work to the video lane and everything else to default", () => {
    expect(laneForType("video.process")).toBe("video");
    expect(laneForType("publish.run")).toBe("default");
    expect(laneForType("webhook.process")).toBe("default");
    expect(laneForType("unknown.type")).toBe("default");
  });

  it("a video job is invisible to a default-lane claim, and claimable by a video worker", async () => {
    const video = seedQueueRow({ type: "video.process", lane: "video" });
    const short = seedQueueRow({ type: "publish.run", lane: "default" });

    const first = await claimNextJob("w1", ["default"]);
    expect(first!.id).toBe(short.id);
    expect(await claimNextJob("w1", ["default"])).toBeNull(); // the render is left alone
    expect(video.status).toBe("PENDING");
    expect(store.rawQueries.at(-1)!.values[2]).toEqual(["default"]);

    const claimed = await claimNextJob("video-worker", ["default", "video"]);
    expect(claimed!.id).toBe(video.id);
    expect(video.lockedBy).toBe("video-worker");
  });

  it("gives the video lane the longer lease", async () => {
    seedQueueRow({ type: "video.process", lane: "video" });
    await claimNextJob("w1", ["video"]);
    expect(store.rawQueries.at(-1)!.values[1]).toBe(600); // 10 minutes, in seconds
    expect((store.jobs[0]!.leaseExpiresAt as Date).getTime()).toBe(DB_NOW + 10 * 60_000);

    store.jobs.length = 0;
    seedQueueRow({ type: "publish.run", lane: "default" });
    await claimNextJob("w1", ["default"]);
    expect(store.rawQueries.at(-1)!.values[1]).toBe(300); // 5 minutes
  });

  it("a whole drain respects the lane split", async () => {
    const seen: string[] = [];
    registerHandler("video.process", async () => {
      seen.push("video");
    });
    registerHandler("telegram.send", async () => {
      seen.push("telegram");
    });
    await enqueue("video.process", { videoJobId: "v1" });
    await enqueue("telegram.send", { leadId: "l1" });

    expect(await drainOnce("cron-worker", 25)).toBe(1); // default lanes only
    expect(seen).toEqual(["telegram"]);

    expect(await drainOnce("ffmpeg-worker", 25, ["default", "video"])).toBe(1);
    expect(seen).toEqual(["telegram", "video"]);
  });

  it("per-job timeouts differ per lane and the video budget is configurable within bounds", () => {
    expect(jobTimeoutMs("default")).toBe(2 * 60_000);
    expect(jobTimeoutMs("video")).toBe(60 * 60_000);
    process.env.VIDEO_JOB_TIMEOUT_MS = "900000";
    expect(jobTimeoutMs("video")).toBe(900_000);
    process.env.VIDEO_JOB_TIMEOUT_MS = "1000"; // below the floor → ignored
    expect(jobTimeoutMs("video")).toBe(60 * 60_000);
    process.env.VIDEO_JOB_TIMEOUT_MS = String(99 * 3600_000); // above the ceiling → clamped
    expect(jobTimeoutMs("video")).toBe(6 * 3600_000);
    delete process.env.VIDEO_JOB_TIMEOUT_MS;
    expect(jobTimeoutMs("video")).toBe(60 * 60_000);
  });

  it("a lane this build does not know still gets a real budget", () => {
    // DEFECT (fixed): the lookup was unguarded, so an unknown lane string —
    // `job.lane` is a plain text column that is read back and cast — produced
    // undefined, and setTimeout(undefined) fires on the next tick.
    expect(jobTimeoutMs("audio" as JobLane)).toBe(jobTimeoutMs("default"));
    expect(jobTimeoutMs("audio" as JobLane)).toBeGreaterThan(0);
  });

  it("a job on an unknown lane runs instead of being abandoned the instant it starts", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal: AbortSignal | undefined;
    registerHandler("email.send", async (_p, _j, s) => {
      signal = s;
      await work;
    });
    const row = seedQueueRow({ type: "email.send", lane: "audio", status: "RUNNING", lockedBy: "w1", attempts: 1 });

    const run = processJob(row as unknown as Job, "w1");
    await vi.advanceTimersByTimeAsync(10);

    expect(signal?.aborted).toBe(false); // it used to be aborted before it had done anything
    finish?.();
    await run;
    expect(row.status).toBe("COMPLETED");
  });
});

describe("claiming a job", () => {
  it("never hands out a job that has exhausted its attempts", async () => {
    seedQueueRow({ attempts: 5, maxAttempts: 5, status: "FAILED" });
    expect(await claimNextJob("w1", ["default"])).toBeNull();

    seedQueueRow({ attempts: 4, maxAttempts: 5, status: "FAILED", id: "q-live" });
    const claimed = await claimNextJob("w1", ["default"]);
    expect(claimed!.id).toBe("q-live");
    expect(claimed!.attempts).toBe(5); // the claim itself counts the attempt
  });

  it("leaves a job whose runAt is still in the future", async () => {
    seedQueueRow({ runAt: new Date(DB_NOW + 60_000) });
    expect(await claimNextJob("w1", ["default"])).toBeNull();
    store.dbNow = DB_NOW + 61_000;
    expect(await claimNextJob("w1", ["default"])).not.toBeNull();
  });

  it("takes the highest priority first, then the oldest", async () => {
    seedQueueRow({ id: "low", priority: 0, runAt: new Date(DB_NOW - 10_000) });
    seedQueueRow({ id: "high", priority: 5, runAt: new Date(DB_NOW - 1_000) });
    seedQueueRow({ id: "older", priority: 0, runAt: new Date(DB_NOW - 20_000) });

    expect((await claimNextJob("w", ["default"]))!.id).toBe("high");
    expect((await claimNextJob("w", ["default"]))!.id).toBe("older");
    expect((await claimNextJob("w", ["default"]))!.id).toBe("low");
  });

  it("skips a RUNNING job and takes a FAILED one that is due for its retry", async () => {
    seedQueueRow({ id: "running", status: "RUNNING", lockedBy: "other" });
    seedQueueRow({ id: "retry", status: "FAILED" });
    const claimed = await claimNextJob("w", ["default"]);
    expect(claimed!.id).toBe("retry");
    expect(claimed!.status).toBe("RUNNING");
    expect(claimed!.lockedBy).toBe("w");
  });
});

describe("leases and heartbeats", () => {
  it("renews the lease of a job this worker still holds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DB_NOW));
    const row = seedQueueRow({ status: "RUNNING", lockedBy: "w1", leaseExpiresAt: new Date(DB_NOW + 10_000) });

    expect(await heartbeatJob(row.id as string, "w1", "default")).toBe(true);
    expect((row.leaseExpiresAt as Date).getTime()).toBe(DB_NOW + 5 * 60_000);

    vi.setSystemTime(new Date(DB_NOW + 60_000));
    expect(await heartbeatJob(row.id as string, "w1", "video")).toBe(true);
    expect((row.leaseExpiresAt as Date).getTime()).toBe(DB_NOW + 60_000 + 10 * 60_000);
  });

  it("refuses to extend a lease this worker no longer owns", async () => {
    const row = seedQueueRow({ status: "RUNNING", lockedBy: "w2", leaseExpiresAt: new Date(DB_NOW + 10_000) });
    const before = row.leaseExpiresAt;

    expect(await heartbeatJob(row.id as string, "w1", "default")).toBe(false);
    expect(row.leaseExpiresAt).toBe(before);

    Object.assign(row, { lockedBy: "w1", status: "FAILED" }); // recovery already gave up on it
    expect(await heartbeatJob(row.id as string, "w1", "default")).toBe(false);
    expect(row.leaseExpiresAt).toBe(before);
  });

  it("completeJob and failJob only write while this worker holds the lock", async () => {
    const row = seedQueueRow({ status: "RUNNING", lockedBy: "w2", attempts: 1 });

    expect(await completeJob(row.id as string, "w1")).toBe(false);
    expect(row.status).toBe("RUNNING");
    expect(await failJob(row as unknown as Job, new Error("x"), "w1")).toBe(false);
    expect(row.status).toBe("RUNNING");

    expect(await completeJob(row.id as string, "w2")).toBe(true);
    expect(row.status).toBe("COMPLETED");
    expect(row.lockedBy).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
  });

  it("failJob backs off, then dead-letters once the attempts are spent", async () => {
    const retrying = seedQueueRow({ status: "RUNNING", lockedBy: "w1", attempts: 1, maxAttempts: 3 });
    expect(await failJob(retrying as unknown as Job, new Error("boom"), "w1")).toBe(true);
    expect(retrying.status).toBe("FAILED");
    expect(String(retrying.lastError)).toBe("Error: boom");
    expect((retrying.runAt as Date).getTime()).toBeGreaterThanOrEqual(Date.now() + 30_000);

    const spent = seedQueueRow({ status: "RUNNING", lockedBy: "w1", attempts: 3, maxAttempts: 3 });
    const runAtBefore = spent.runAt;
    expect(await failJob(spent as unknown as Job, new Error("boom"), "w1")).toBe(true);
    expect(spent.status).toBe("DEAD");
    expect(spent.runAt).toBe(runAtBefore); // a dead job is not rescheduled
  });

  it("backoff grows exponentially and is capped at two hours", () => {
    expect(backoffMs(1)).toBeGreaterThanOrEqual(30_000);
    expect(backoffMs(1)).toBeLessThan(35_001);
    expect(backoffMs(2)).toBeGreaterThanOrEqual(120_000);
    expect(backoffMs(3)).toBeGreaterThanOrEqual(480_000);
    expect(backoffMs(20)).toBeLessThanOrEqual(2 * 3600_000 + 5_000);
  });
});

describe("recovering jobs whose worker died", () => {
  it("revives a lapsed lease with backoff, not instantly", async () => {
    const row = seedQueueRow({ status: "RUNNING", lockedBy: "dead-worker", attempts: 1, maxAttempts: 5, leaseExpiresAt: new Date(Date.now() - 1000) });

    expect(await recoverStaleJobs()).toBe(1);

    expect(row.status).toBe("FAILED");
    expect(row.lockedBy).toBeNull();
    expect(row.leaseExpiresAt).toBeNull();
    expect(String(row.lastError)).toMatch(/lock expired/i);
    expect((row.runAt as Date).getTime()).toBeGreaterThan(Date.now() + 25_000); // real backoff
  });

  it("dead-letters a recovered job that has no attempts left", async () => {
    const row = seedQueueRow({ status: "RUNNING", lockedBy: "dead", attempts: 5, maxAttempts: 5, leaseExpiresAt: new Date(Date.now() - 1) });
    const runAtBefore = row.runAt;

    await recoverStaleJobs();

    expect(row.status).toBe("DEAD");
    expect(String(row.lastError)).toMatch(/retries are exhausted/i);
    expect(row.runAt).toBe(runAtBefore);
  });

  it("leaves a live lease alone and picks up legacy rows with no lease at all", async () => {
    const live = seedQueueRow({ status: "RUNNING", lockedBy: "w1", leaseExpiresAt: new Date(Date.now() + 60_000) });
    const legacy = seedQueueRow({ status: "RUNNING", lockedBy: "w0", leaseExpiresAt: null, lockedAt: new Date(Date.now() - 6 * 60_000), attempts: 1, maxAttempts: 5 });
    const fresh = seedQueueRow({ status: "RUNNING", lockedBy: "w0", leaseExpiresAt: null, lockedAt: new Date(Date.now() - 60_000) });

    expect(await recoverStaleJobs()).toBe(1);

    expect(live.status).toBe("RUNNING");
    expect(fresh.status).toBe("RUNNING");
    expect(legacy.status).toBe("FAILED");
  });

  it("does nothing when nothing is stale", async () => {
    seedQueueRow({ status: "PENDING" });
    expect(await recoverStaleJobs()).toBe(0);
  });
});

describe("running one job", () => {
  it("completes a job and clears its lock", async () => {
    let ran = 0;
    registerHandler("email.send", async (payload) => {
      ran++;
      expect(payload.emailEventId).toBe("e1");
    });
    const row = seedQueueRow({ type: "email.send", payload: { emailEventId: "e1" }, status: "RUNNING", lockedBy: "w1", attempts: 1 });

    await processJob(row as unknown as Job, "w1");

    expect(ran).toBe(1);
    expect(row.status).toBe("COMPLETED");
    expect(row.lockedBy).toBeNull();
  });

  it("fails a job with no registered handler instead of silently dropping it", async () => {
    const row = seedQueueRow({ type: "nope.nothing", status: "RUNNING", lockedBy: "w1", attempts: 1, maxAttempts: 3 });

    await processJob(row as unknown as Job, "w1");

    expect(row.status).toBe("FAILED");
    expect(String(row.lastError)).toMatch(/No handler registered/);
  });

  it("renews the lease while a long handler runs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(DB_NOW));
    let finish: (() => void) | undefined;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    registerHandler("email.send", async () => {
      await slow;
    });
    const row = seedQueueRow({
      type: "email.send",
      status: "RUNNING",
      lockedBy: "w1",
      attempts: 1,
      leaseExpiresAt: new Date(DB_NOW + 30_000),
    });

    const run = processJob(row as unknown as Job, "w1");
    await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS + 10);

    expect((row.leaseExpiresAt as Date).getTime()).toBeGreaterThan(DB_NOW + 5 * 60_000); // renewed, not the seeded value
    finish?.();
    await run;
    expect(row.status).toBe("COMPLETED");
  });

  it("a handler that outruns its budget keeps its lease instead of being retried underneath itself", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal: AbortSignal | undefined;
    registerHandler("email.send", async (_p, _j, s) => {
      signal = s;
      await hung;
    });
    const row = seedQueueRow({ type: "email.send", status: "RUNNING", lockedBy: "w1", attempts: 1 });
    const runAt = row.runAt;

    const run = processJob(row as unknown as Job, "w1");
    await vi.advanceTimersByTimeAsync(jobTimeoutMs("default") + 10);
    await run;

    expect(signal?.aborted).toBe(true);
    expect(row.status).toBe("RUNNING");
    expect(row.lockedBy).toBe("w1");
    expect(row.runAt).toBe(runAt);

    finish?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(row.status).toBe("COMPLETED"); // its real outcome, once it came back
  });

  it("does not abandon a video render at the default budget", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const render = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal: AbortSignal | undefined;
    registerHandler("video.process", async (_p, _j, s) => {
      signal = s;
      await render;
    });
    const row = seedQueueRow({ type: "video.process", lane: "video", status: "RUNNING", lockedBy: "w1", attempts: 1 });

    const run = processJob(row as unknown as Job, "w1");
    await vi.advanceTimersByTimeAsync(5 * 60_000); // well past the default lane's 2 minutes

    expect(signal?.aborted).toBe(false);
    expect(row.status).toBe("RUNNING");
    finish?.();
    await run;
    expect(row.status).toBe("COMPLETED");
  });

  it("a late outcome is dropped once the job belongs to another worker", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const hung = new Promise<void>((resolve) => {
      finish = resolve;
    });
    registerHandler("email.send", async () => {
      await hung;
    });
    const row = seedQueueRow({ type: "email.send", status: "RUNNING", lockedBy: "w1", attempts: 1 });

    const run = processJob(row as unknown as Job, "w1");
    await vi.advanceTimersByTimeAsync(jobTimeoutMs("default") + 10);
    await run;

    Object.assign(row, { status: "RUNNING", lockedBy: "w2" }); // recovery handed it on
    finish?.();
    await vi.advanceTimersByTimeAsync(1);

    expect(row.lockedBy).toBe("w2");
    expect(row.status).toBe("RUNNING");
  });
});

describe("enqueueing", () => {
  it("stores the lane, priority, attempts cap and run time", async () => {
    const job = await enqueue("publish.run", { publishJobId: "pj1" }, { runAt: new Date(DB_NOW + 5_000), priority: 5, maxAttempts: 3 });
    expect(job).not.toBeNull();
    expect(store.jobs[0]).toMatchObject({ type: "publish.run", lane: "default", priority: 5, maxAttempts: 3, status: "PENDING", attempts: 0 });
    expect((store.jobs[0]!.payload as Row).publishJobId).toBe("pj1");

    await enqueue("video.process", { videoJobId: "v1" });
    expect(store.jobs[1]!.lane).toBe("video");
    expect(store.jobs[1]!.maxAttempts).toBe(5); // the default
  });

  it("an idempotency key makes a second enqueue a no-op, not an error", async () => {
    const first = await enqueue("telegram.send", { leadId: "l1" }, { idempotencyKey: "telegram:l1" });
    const second = await enqueue("telegram.send", { leadId: "l1" }, { idempotencyKey: "telegram:l1" });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(store.jobs).toHaveLength(1);

    const other = await enqueue("telegram.send", { leadId: "l2" }, { idempotencyKey: "telegram:l2" });
    expect(other).not.toBeNull();
    expect(store.jobs).toHaveLength(2);
  });

  it("an explicit lane overrides the type's own", async () => {
    await enqueue("publish.run", {}, { lane: "video" });
    expect(store.jobs[0]!.lane).toBe("video");
  });

  it("reports the queue's depth and the age of its oldest waiting job", async () => {
    seedQueueRow({ status: "PENDING", runAt: new Date(Date.now() - 120_000) });
    seedQueueRow({ status: "FAILED" });
    seedQueueRow({ status: "DEAD" });
    seedQueueRow({ status: "COMPLETED" });

    const depth = await queueDepth();
    expect(depth).toMatchObject({ pending: 1, failed: 1, dead: 1 });
    expect(depth.oldestPendingAgeSec).toBeGreaterThanOrEqual(119);
  });
});

describe("the queue and publishing together", () => {
  it("a queued publish.run pass drains into a real Instagram publish, exactly once", async () => {
    const job = seedPublishJob({ containerId: null });
    store.graph = graphScript({ containers: ["c1"], mediaId: "m1" });
    registerHandler("publish.run", async (payload) => {
      await runPublishJob(String(payload.publishJobId));
    });

    await enqueue("publish.run", { publishJobId: job.id }, { idempotencyKey: publishRunKey(job.id as string, "test") });
    const processed = await drainOnce("worker-1", 25);

    expect(processed).toBe(1);
    expect(job.status).toBe("PUBLISHED");
    expect(posted("ig1/media_publish")).toHaveLength(1);
    expect(store.jobs[0]!.status).toBe("COMPLETED");

    // a duplicate delivery of the same pass cannot post a second time
    await enqueue("publish.run", { publishJobId: job.id }, { idempotencyKey: publishRunKey(job.id as string, "test") });
    expect(store.jobs.filter((j) => j.type === "publish.run")).toHaveLength(1);
  });

  it("a poll cycle queued by one pass is picked up and finished by the next drain", async () => {
    const job = seedPublishJob({ containerId: "c1" });
    registerHandler("publish.run", async (payload) => {
      await runPublishJob(String(payload.publishJobId));
    });
    store.graph = graphScript({ status: { status_code: "IN_PROGRESS" } });

    await enqueue("publish.run", { publishJobId: job.id }, { idempotencyKey: publishRunKey(job.id as string, "first") });
    await drainOnce("worker-1", 5);

    const poll = pendingPasses()[0]!;
    expect(poll.idempotencyKey).toBe(publishRunKey(job.id as string, "poll:1"));
    expect(job.status).toBe("PROCESSING");

    // the poll row is not due yet — a drain now must not touch it
    expect(await drainOnce("worker-1", 5)).toBe(0);

    store.dbNow = (poll.runAt as Date).getTime() + 1;
    store.graph = graphScript({ status: { status_code: "FINISHED" }, mediaId: "m1" });
    expect(await drainOnce("worker-1", 5)).toBe(1);
    expect(job.status).toBe("PUBLISHED");
  });

  it("the worker's own handler registry really contains publish.run", async () => {
    await import("@/lib/queue/handlers");
    const handler = getHandler("publish.run");
    expect(handler).toBeTypeOf("function");

    const job = seedPublishJob({ containerId: "c1" });
    store.graph = graphScript({ mediaId: "m_real" });
    await handler!({ publishJobId: job.id }, seedQueueRow() as unknown as Job, new AbortController().signal);

    expect(job.status).toBe("PUBLISHED");
    expect(job.publishedMediaId).toBe("m_real");
  });
});
