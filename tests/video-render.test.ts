import { beforeEach, describe, it, expect, vi } from "vitest";
import { buildRenderArgs, atempoChain, resolveTargetSize, effectiveDuration, escapeFilterPath, buildAudioExtractArgs, buildThumbnailArgs } from "@/lib/video/render";
import { applyEditPatch, defaultEditParams } from "@/lib/video/params";
import { enqueueVideoJob, reconcileStalledVideoJobs, runVideoJob } from "@/lib/video/jobs";

type Row = Record<string, unknown>;

/**
 * The job lifecycle is pure bookkeeping between two tables, so it is tested
 * against an in-memory stand-in for the two of them — no database, no FFmpeg.
 */
const { store, enqueueMock, prismaMock } = vi.hoisted(() => {
  const store = {
    videoJobs: [] as Row[],
    jobs: [] as Row[],
    seq: 0,
    /** Lets a test mutate the snapshot a read returns, to stage a lost update. */
    onVideoJobRead: null as null | ((snapshot: Row) => void),
  };

  const matches = (row: Row, where: Row = {}): boolean =>
    Object.entries(where).every(([key, cond]) => {
      const value = row[key];
      if (cond !== null && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as Record<string, unknown>;
        if ("in" in c) return (c.in as unknown[]).includes(value);
        if ("lt" in c) return value != null && (value as Date) < (c.lt as Date);
        return false;
      }
      return value === cond;
    });

  const table = (rows: Row[], prefix: string, onRead?: () => ((snapshot: Row) => void) | null) => ({
    create: async ({ data }: { data: Row }) => {
      const row: Row = { id: `${prefix}${++store.seq}`, status: "QUEUED", progressPct: 0, error: null, startedAt: null, finishedAt: null, queueJobId: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return { ...row };
    },
    findUnique: async ({ where }: { where: Row }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) return null;
      const snapshot = { ...row };
      onRead?.()?.(snapshot);
      return snapshot;
    },
    findFirst: async ({ where }: { where: Row }) => {
      const row = rows.find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    findMany: async ({ where, take }: { where?: Row; take?: number } = {}) => rows.filter((r) => matches(r, where)).slice(0, take ?? rows.length).map((r) => ({ ...r })),
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((r) => matches(r, where));
      if (!row) throw new Error("record not found");
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data, { updatedAt: new Date() });
      return { count: hit.length };
    },
    delete: async ({ where }: { where: Row }) => {
      const i = rows.findIndex((r) => matches(r, where));
      if (i === -1) throw new Error("record not found");
      return rows.splice(i, 1)[0];
    },
  });

  return {
    store,
    // Mirrors the real queue: a second enqueue under a live key is a no-op.
    enqueueMock: vi.fn(async (_type: string, payload: Record<string, unknown>, opts?: { idempotencyKey?: string }) => {
      const key = opts?.idempotencyKey ?? null;
      if (key && store.jobs.some((j) => j.idempotencyKey === key)) return null;
      // The real queue stores the payload with the row, which is what names the
      // VideoJob behind a key before the reverse link is written.
      const job: Row = { id: `q${++store.seq}`, idempotencyKey: key, payload, status: "PENDING", attempts: 0, maxAttempts: 3 };
      store.jobs.push(job);
      return job;
    }),
    prismaMock: {
      videoJob: table(store.videoJobs, "vj", () => store.onVideoJobRead),
      job: table(store.jobs, "q"),
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queue")>()),
  enqueue: enqueueMock,
}));

function seedVideoJob(row: Row): Row {
  const seeded: Row = {
    id: `vj-${store.videoJobs.length + 1}`,
    accountId: "acc1",
    projectId: "prj1",
    kind: "THUMBNAIL",
    status: "QUEUED",
    params: {},
    progressPct: 0,
    error: null,
    queueJobId: null,
    startedAt: null,
    finishedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...row,
  };
  store.videoJobs.push(seeded);
  return seeded;
}

const HOUR_AGO = () => new Date(Date.now() - 60 * 60_000);

const SOURCE = { width: 1920, height: 1080, durationSec: 60, hasAudio: true };

function args(patch: Record<string, unknown>, opts: { audioPaths?: string[]; subtitlePath?: string | null; quality?: "preview" | "export" } = {}) {
  return buildRenderArgs({
    sourcePath: "/tmp/in.mp4",
    audioPaths: opts.audioPaths ?? [],
    subtitlePath: opts.subtitlePath ?? null,
    outputPath: "/tmp/out.mp4",
    params: applyEditPatch(defaultEditParams(), patch),
    source: SOURCE,
    quality: opts.quality ?? "export",
  }).args;
}

function filterGraph(a: string[]): string {
  const i = a.indexOf("-filter_complex");
  return i === -1 ? "" : (a[i + 1] ?? "");
}

/**
 * The renderer turns validated parameters into an argv array. These tests are
 * the contract that nothing else can get in: no shell string is ever built, and
 * user text reaches FFmpeg only through a file path we created.
 */
describe("render argument construction", () => {
  it("passes arguments as an array with no shell metacharacters", () => {
    const a = args({});
    expect(Array.isArray(a)).toBe(true);
    // A shell would be needed for any of these; there is no shell.
    expect(a.join(" ")).not.toMatch(/[;&|`]\s*(rm|curl|wget|sh|bash)/);
    expect(a).toContain("-i");
    expect(a[a.length - 1]).toBe("/tmp/out.mp4");
  });

  it("mixes original and uploaded audio as independent levels", () => {
    const g = filterGraph(
      args({ audio: { originalVolume: 30, tracks: [{ assetId: "a1", volume: 100 }] } }, { audioPaths: ["/tmp/music.mp3"] }),
    );
    expect(g).toContain("[0:a]volume=0.3000");
    expect(g).toContain("volume=1.0000");
    expect(g).toContain("amix=inputs=2");
    // normalize=0 keeps each level exactly as asked, instead of FFmpeg
    // silently halving both when two inputs are mixed.
    expect(g).toContain("normalize=0");
  });

  it("drops the original track entirely when muted", () => {
    const g = filterGraph(
      args({ audio: { muteOriginal: true, tracks: [{ assetId: "a1", volume: 80 }] } }, { audioPaths: ["/tmp/music.mp3"] }),
    );
    expect(g).not.toContain("[0:a]");
    expect(g).toContain("volume=0.8000");
  });

  it("produces a silent render when the source has no audio and no track is added", () => {
    const a = buildRenderArgs({
      sourcePath: "/tmp/in.mp4",
      audioPaths: [],
      outputPath: "/tmp/out.mp4",
      params: defaultEditParams(),
      source: { ...SOURCE, hasAudio: false },
      quality: "export",
    }).args;
    expect(a).toContain("-an");
  });

  it("uses sidechain compression for ducking, and only when asked", () => {
    const ducked = filterGraph(
      args({ audio: { tracks: [{ assetId: "a1", volume: 100, duckUnderSpeech: true }] } }, { audioPaths: ["/tmp/m.mp3"] }),
    );
    expect(ducked).toContain("sidechaincompress");

    const plain = filterGraph(args({ audio: { tracks: [{ assetId: "a1", volume: 100 }] } }, { audioPaths: ["/tmp/m.mp3"] }));
    expect(plain).not.toContain("sidechaincompress");
  });

  it("delays, trims and fades an uploaded track as instructed", () => {
    const g = filterGraph(
      args(
        { audio: { tracks: [{ assetId: "a1", volume: 50, startSec: 2, trimStartSec: 1, trimEndSec: 9, fadeInSec: 1, fadeOutSec: 2 }] } },
        { audioPaths: ["/tmp/m.mp3"] },
      ),
    );
    expect(g).toContain("atrim=start=1:end=9");
    expect(g).toContain("adelay=2000:all=1");
    expect(g).toContain("afade=t=in");
    expect(g).toContain("afade=t=out");
  });

  it("requests -stream_loop before the input it applies to", () => {
    const a = args({ audio: { tracks: [{ assetId: "a1", volume: 100, loop: true }] } }, { audioPaths: ["/tmp/m.mp3"] });
    const loopIdx = a.indexOf("-stream_loop");
    const musicIdx = a.indexOf("/tmp/m.mp3");
    expect(loopIdx).toBeGreaterThan(-1);
    expect(loopIdx).toBeLessThan(musicIdx);
    // and the video must not be stretched to the looped music
    expect(a).toContain("-shortest");
  });

  it("keeps sped-up speech natural by chaining atempo", () => {
    expect(atempoChain(2)).toEqual(["atempo=2.000000"]);
    expect(atempoChain(4)).toEqual(["atempo=2.0", "atempo=2.000000"]);
    expect(atempoChain(0.25)).toEqual(["atempo=0.5", "atempo=0.500000"]);
    // every stage must stay inside FFmpeg's accepted 0.5–2.0 window
    for (const stage of atempoChain(3.7)) {
      const v = Number(stage.split("=")[1]);
      expect(v).toBeGreaterThanOrEqual(0.5);
      expect(v).toBeLessThanOrEqual(2.0);
    }
  });

  it("references subtitles as a file path, never as inlined text", () => {
    const g = filterGraph(args({ subtitles: { burnIn: true } }, { subtitlePath: "/tmp/subs.ass" }));
    expect(g).toContain("subtitles='/tmp/subs.ass'");
  });

  it("escapes a Windows path so the drive colon cannot split the filter", () => {
    const escaped = escapeFilterPath("C:\\Users\\me\\subs.ass");
    expect(escaped).toBe("C\\:/Users/me/subs.ass");
    expect(escapeFilterPath("/tmp/a'b[c].ass")).toBe("/tmp/a\\'b\\[c\\].ass");
  });

  it("crops for cover and pads for contain", () => {
    expect(filterGraph(args({ video: { aspect: "9:16", fit: "cover" } }))).toContain("crop=");
    const contain = filterGraph(args({ video: { aspect: "9:16", fit: "contain", padColor: "#112233" } }));
    expect(contain).toContain("pad=");
    expect(contain).toContain("0x112233");
  });

  it("always outputs a web-playable, Meta-fetchable file", () => {
    const a = args({});
    expect(a).toContain("libx264");
    expect(a).toContain("yuv420p");
    expect(a).toContain("+faststart");
    // strip source metadata rather than republishing a customer's GPS tags
    expect(a).toContain("-map_metadata");
  });

  it("renders previews small and fast, exports at quality", () => {
    const preview = resolveTargetSize(applyEditPatch(defaultEditParams(), { video: { aspect: "9:16" } }), SOURCE, "preview");
    const exported = resolveTargetSize(applyEditPatch(defaultEditParams(), { video: { aspect: "9:16" } }), SOURCE, "export");
    expect(preview.height).toBeLessThanOrEqual(640);
    expect(exported.height).toBeGreaterThan(preview.height);
    expect(preview.width % 2).toBe(0);
    expect(preview.height % 2).toBe(0);
  });

  it("computes the duration a render will actually have", () => {
    const p = applyEditPatch(defaultEditParams(), { video: { trim: { startSec: 10, endSec: 40 }, speed: 2 } });
    expect(effectiveDuration(p, 60)).toBe(15);
  });
});

describe("helper invocations", () => {
  it("extracts 16 kHz mono audio for transcription", () => {
    const a = buildAudioExtractArgs("/tmp/in.mp4", "/tmp/out.wav");
    expect(a).toContain("-ar");
    expect(a[a.indexOf("-ar") + 1]).toBe("16000");
    expect(a[a.indexOf("-ac") + 1]).toBe("1");
    expect(a).toContain("-vn");
  });

  it("extracts a single frame at the requested time", () => {
    const a = buildThumbnailArgs("/tmp/in.mp4", "/tmp/out.jpg", 12.5, 720);
    expect(a[a.indexOf("-ss") + 1]).toBe("12.500");
    expect(a[a.indexOf("-frames:v") + 1]).toBe("1");
  });
});

/**
 * A video job row is the only thing the editor watches, so it must never
 * disagree with the queue: no row queued behind a deduplicated key, no cancel
 * overwritten by the run it was meant to stop, no row left running after the
 * process behind it died.
 */
describe("video job lifecycle", () => {
  beforeEach(() => {
    store.videoJobs.length = 0;
    store.jobs.length = 0;
    store.seq = 0;
    store.onVideoJobRead = null;
    enqueueMock.mockClear();
  });

  const input = { accountId: "acc1", projectId: "prj1", kind: "PROBE" as const, params: { assetId: "a1" } };

  it("records the queue entry it created on the happy path", async () => {
    const job = await enqueueVideoJob(input);
    expect(job.status).toBe("QUEUED");
    expect(job.queueJobId).toBe(store.jobs[0]!.id);
    expect(store.videoJobs).toHaveLength(1);
  });

  it("hands back the job that already owns the work instead of queueing a second one", async () => {
    store.jobs.push({ id: "q-first", idempotencyKey: "video-probe:a1", status: "COMPLETED", attempts: 1, maxAttempts: 3 });
    const first = seedVideoJob({ id: "vj-first", status: "DONE", queueJobId: "q-first" });

    const job = await enqueueVideoJob({ ...input, idempotencyKey: "video-probe:a1" });

    expect(job.id).toBe(first.id);
    expect(job.status).toBe("DONE");
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(store.videoJobs).toHaveLength(1);
  });

  it("drops its own row when a concurrent request wins the key", async () => {
    enqueueMock.mockImplementationOnce(async (_type, _payload, opts) => {
      store.jobs.push({ id: "q-winner", idempotencyKey: opts?.idempotencyKey ?? null, status: "PENDING", attempts: 0, maxAttempts: 3 });
      seedVideoJob({ id: "vj-winner", queueJobId: "q-winner" });
      return null;
    });

    const job = await enqueueVideoJob({ ...input, idempotencyKey: "video-probe:a1" });

    expect(job.id).toBe("vj-winner");
    expect(store.videoJobs).toHaveLength(1);
  });

  it("resolves the winner of a duplicate race before its queue link is written", async () => {
    enqueueMock.mockImplementationOnce(async (_type, _payload, opts) => {
      // The winner's queue entry exists but its VideoJob has not yet recorded
      // queueJobId — the window a second identical request lands in.
      store.jobs.push({
        id: "q-winner",
        idempotencyKey: opts?.idempotencyKey ?? null,
        payload: { videoJobId: "vj-winner" },
        status: "PENDING",
        attempts: 0,
        maxAttempts: 3,
      });
      seedVideoJob({ id: "vj-winner", queueJobId: null });
      return null;
    });

    const job = await enqueueVideoJob({ ...input, idempotencyKey: "video-probe:a1" });

    // Not FAILED: the work really is queued, it is just not linked back yet.
    expect(job.id).toBe("vj-winner");
    expect(job.status).toBe("QUEUED");
    expect(store.videoJobs).toHaveLength(1);
  });

  it("fails the row honestly when the key is held by a queue entry no job owns", async () => {
    store.jobs.push({ id: "q-orphan", idempotencyKey: "video-probe:a1", status: "DEAD", attempts: 3, maxAttempts: 3 });

    const job = await enqueueVideoJob({ ...input, idempotencyKey: "video-probe:a1" });

    // Never QUEUED: nothing would ever pick it up.
    expect(job.status).toBe("FAILED");
    expect(job.error).toMatch(/already queued/i);
  });

  it("abandons a run when a cancel lands between the read and the RUNNING write", async () => {
    seedVideoJob({ id: "vj-cancel", status: "CANCELLED" });
    let firstRead = true;
    store.onVideoJobRead = (snapshot) => {
      // The row was still QUEUED when this attempt read it; the cancel landed
      // immediately afterwards.
      if (firstRead) {
        firstRead = false;
        snapshot.status = "QUEUED";
      }
    };

    await runVideoJob("vj-cancel");

    const row = store.videoJobs[0]!;
    expect(row.status).toBe("CANCELLED");
    expect(row.startedAt).toBeNull();
  });

  it("restarts a row left RUNNING by an attempt whose process died", async () => {
    seedVideoJob({ id: "vj-crashed", kind: "WAVEFORM", status: "RUNNING", startedAt: HOUR_AGO() });

    // WAVEFORM is unimplemented, so reaching the dispatch switch at all proves
    // the attempt was not abandoned as someone else's run.
    await expect(runVideoJob("vj-crashed")).rejects.toThrow(/not implemented/i);

    const row = store.videoJobs[0]!;
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatch(/not implemented/i);
  });

  it("fails stalled jobs whose queue entry is gone, and leaves live ones alone", async () => {
    store.jobs.push(
      { id: "q-dead", idempotencyKey: null, status: "DEAD", attempts: 3, maxAttempts: 3 },
      { id: "q-running", idempotencyKey: null, status: "RUNNING", attempts: 1, maxAttempts: 3 },
      { id: "q-retrying", idempotencyKey: null, status: "FAILED", attempts: 1, maxAttempts: 3 },
    );
    seedVideoJob({ id: "vj-dead", status: "RUNNING", queueJobId: "q-dead", startedAt: HOUR_AGO(), updatedAt: HOUR_AGO() });
    seedVideoJob({ id: "vj-live", status: "RUNNING", queueJobId: "q-running", startedAt: HOUR_AGO(), updatedAt: HOUR_AGO() });
    seedVideoJob({ id: "vj-retrying", status: "RUNNING", queueJobId: "q-retrying", startedAt: HOUR_AGO(), updatedAt: HOUR_AGO() });
    seedVideoJob({ id: "vj-never-queued", status: "QUEUED", queueJobId: null, updatedAt: HOUR_AGO() });
    seedVideoJob({ id: "vj-fresh", status: "RUNNING", queueJobId: "q-dead", startedAt: new Date(), updatedAt: new Date() });

    const failed = await reconcileStalledVideoJobs();

    expect(failed).toBe(2);
    const byId = Object.fromEntries(store.videoJobs.map((r) => [r.id as string, r]));
    expect(byId["vj-dead"]!.status).toBe("FAILED");
    expect(byId["vj-dead"]!.error).toMatch(/worker stopped/i);
    expect(byId["vj-never-queued"]!.status).toBe("FAILED");
    // A retry is still pending and a running render is still running: neither is
    // abandoned, however long it has been going.
    expect(byId["vj-live"]!.status).toBe("RUNNING");
    expect(byId["vj-retrying"]!.status).toBe("RUNNING");
    expect(byId["vj-fresh"]!.status).toBe("RUNNING");
  });

  it("fails a job whose worker died on its last attempt, but not one still holding its lease", async () => {
    // Both entries have exhausted their retries, so neither will ever be
    // claimed again; only the lease says whether one is still being worked on.
    store.jobs.push(
      { id: "q-abandoned", idempotencyKey: null, status: "RUNNING", attempts: 3, maxAttempts: 3, leaseExpiresAt: HOUR_AGO(), lockedAt: HOUR_AGO() },
      { id: "q-held", idempotencyKey: null, status: "RUNNING", attempts: 3, maxAttempts: 3, leaseExpiresAt: new Date(Date.now() + 5 * 60_000), lockedAt: HOUR_AGO() },
    );
    seedVideoJob({ id: "vj-abandoned", status: "RUNNING", queueJobId: "q-abandoned", startedAt: HOUR_AGO(), updatedAt: HOUR_AGO() });
    seedVideoJob({ id: "vj-held", status: "RUNNING", queueJobId: "q-held", startedAt: HOUR_AGO(), updatedAt: HOUR_AGO() });

    expect(await reconcileStalledVideoJobs()).toBe(1);

    const byId = Object.fromEntries(store.videoJobs.map((r) => [r.id as string, r]));
    expect(byId["vj-abandoned"]!.status).toBe("FAILED");
    expect(byId["vj-abandoned"]!.error).toMatch(/worker stopped/i);
    expect(byId["vj-held"]!.status).toBe("RUNNING");
  });

  it("leaves a job still waiting in the queue backlog alone", async () => {
    store.jobs.push({ id: "q-pending", idempotencyKey: null, status: "PENDING", attempts: 0, maxAttempts: 3 });
    seedVideoJob({ id: "vj-backlog", status: "QUEUED", queueJobId: "q-pending", updatedAt: HOUR_AGO() });

    expect(await reconcileStalledVideoJobs()).toBe(0);
    expect(store.videoJobs[0]!.status).toBe("QUEUED");
  });
});
