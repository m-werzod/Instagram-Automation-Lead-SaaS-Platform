import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AIProviderType, VideoJobKind } from "@prisma/client";

/**
 * AI Video Editor — end-to-end QA with REAL FFmpeg.
 *
 * Nothing here trusts the shape of a command string. Every claim about the
 * editor is settled by encoding a file and measuring it:
 *
 *   picture  — a frame is decoded to 8-bit grey and its mean luma taken. The
 *              fixtures are pure black, so "mean luma > 0" means pixels were
 *              drawn, and comparing two renders of equal-length text tells real
 *              glyphs (different shapes, different ink) from .notdef boxes
 *              (identical shapes, identical ink).
 *   sound    — a band-pass around a known tone plus volumedetect. The source's
 *              own audio is 440 Hz and the "music" track is 1 kHz, so one
 *              render answers what happened to each of them independently.
 *
 * Prisma is an in-memory stand-in; storage is the real local driver writing to
 * a temp root; FFmpeg is the real binary.
 */

// ---- in-memory Prisma ----


const { store, prismaMock } = vi.hoisted(() => {
  const store = {
    videoJob: [] as Record<string, unknown>[],
    videoProject: [] as Record<string, unknown>[],
    videoAsset: [] as Record<string, unknown>[],
    subtitleTrack: [] as Record<string, unknown>[],
    job: [] as Record<string, unknown>[],
    seq: 0,
  };

  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean =>
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

  const table = (
    rows: Record<string, unknown>[],
    prefix: string,
    hydrate?: (row: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const out = (r: Record<string, unknown>) => (hydrate ? hydrate({ ...r }) : { ...r });
    return {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `${prefix}${++store.seq}`, createdAt: new Date(), updatedAt: new Date(), ...data };
        rows.push(row);
        return out(row);
      },
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const r = rows.find((x) => matches(x, where));
        return r ? out(r) : null;
      },
      findFirst: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        const r = rows.find((x) => matches(x, where));
        return r ? out(r) : null;
      },
      findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number } = {}) =>
        rows.filter((x) => matches(x, where)).slice(0, take ?? rows.length).map(out),
      update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const r = rows.find((x) => matches(x, where));
        if (!r) throw new Error("record not found");
        Object.assign(r, data, { updatedAt: new Date() });
        return out(r);
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((x) => matches(x, where));
        for (const r of hit) Object.assign(r, data, { updatedAt: new Date() });
        return { count: hit.length };
      },
      delete: async ({ where }: { where: Record<string, unknown> }) => {
        const i = rows.findIndex((x) => matches(x, where));
        if (i === -1) throw new Error("record not found");
        return rows.splice(i, 1)[0];
      },
    };
  };

  return {
    store,
    prismaMock: {
      videoJob: table(store.videoJob, "vj"),
      videoProject: table(store.videoProject, "vp", (r) => ({
        ...r,
        sourceAsset: store.videoAsset.find((a) => a.id === r.sourceAssetId) ?? null,
      })),
      videoAsset: table(store.videoAsset, "va"),
      subtitleTrack: table(store.subtitleTrack, "st"),
      job: table(store.job, "q"),
    },
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

// The queue is not under test here and importing it for real would drag the
// whole worker in; jobs.ts only needs these two symbols to exist.
vi.mock("@/lib/queue", () => ({
  enqueue: vi.fn(async () => null),
  registerHandler: vi.fn(),
  isVideoWorkerOnline: vi.fn(async () => true),
}));

const chatMock = vi.fn();

vi.mock("@/lib/ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai")>()),
  getProvider: () => ({ name: "anthropic" as const, chat: chatMock }),
  recordUsage: vi.fn(async () => {}),
}));

// ---- product under test ----

import { ffmpeg, FfmpegError, FfmpegMissingError, parseProgressSeconds } from "@/lib/video/ffmpeg";
import { probeFile, validateUpload, UnsupportedMediaError } from "@/lib/video/probe";
import {
  atempoChain,
  buildAudioExtractArgs,
  buildRenderArgs,
  buildThumbnailArgs,
  effectiveDuration,
  escapeFilterPath,
  resolveTargetSize,
} from "@/lib/video/render";
import {
  applyEditPatch,
  checkExportForInstagram,
  defaultEditParams,
  diffEditParams,
  editParamsSchema,
  mergeSubtitleStyle,
  SUBTITLE_PRESETS,
  type EditParams,
  type SubtitlePreset,
} from "@/lib/video/params";
import {
  applyPreset,
  buildAssFile,
  buildSrtFile,
  buildVttFile,
  cuesSchema,
  normalizeCues,
  parseSubtitleFile,
  retimeCues,
  wrapCueText,
  type SubtitleCue,
} from "@/lib/video/subtitles";
import { LocalDriver } from "@/lib/storage/local";
import { VercelBlobDriver } from "@/lib/storage/vercel-blob";
import {
  UploadTooLargeError,
  _resetStorageDriver,
  assertSafeKey,
  buildStorageKey,
  extensionOf,
  maxUploadBytes,
  isPubliclyReachable,
  signAssetToken,
  StorageError,
  verifyAssetToken,
} from "@/lib/storage";
import { parseByteRange } from "@/lib/http/range";
import {
  acquireUploadSlot,
  readBoundedBody,
  uploadsInFlight,
  UploadTooLargeError as BodyTooLargeError,
  UploadStalledError,
  _resetUploadSlots,
} from "@/lib/http/upload-guard";
import { buildEditingPlan, measureSample, planPatch, type MeasuredStyle, type ObservedStyle } from "@/lib/video/sample";
import { detectLanguage, runAssistantTurn } from "@/lib/video/assistant";
import { cancelVideoJob, enqueueVideoJob, reconcileStalledVideoJobs, runVideoJob } from "@/lib/video/jobs";
import { canPublishReason } from "@/lib/video/publish-check";
import { parseCueJson, SttUnavailableError, sttModel, sttStatus, transcribeAudio } from "@/lib/video/stt";
import { enqueue, isVideoWorkerOnline } from "@/lib/queue";
import { videoCapabilities } from "@/lib/video/service";

// ---- fixtures ----

let DIR = "";
let STORE_ROOT = "";
/** 12 s, 360x640, pure black, with a continuous 440 Hz tone at -6 dBFS. */
let SRC12 = "";
/** 12 s, same picture, 440 Hz tone present ONLY between 4 s and 8 s. */
let SPEECH12 = "";
/** 12 s of 1 kHz at -6 dBFS — stands in for an uploaded music track. */
let MUSIC12 = "";
/** 2 s, 320x568, black, no audio — the cheap canvas for caption renders. */
let SHORT2 = "";
/** 8 s, 320x568, black/white/black/white in 2 s blocks: cuts at 2, 4 and 6. */
let CUTS8 = "";

let frameSeq = 0;

async function gen(name: string, args: string[]): Promise<string> {
  const out = join(DIR, name);
  await ffmpeg(["-hide_banner", "-nostdin", "-y", ...args, out], { timeoutMs: 120_000 });
  return out;
}

/** Mean luma (0-255) of one decoded frame. Black fixtures make this "ink". */
async function ink(video: string, atSec: number): Promise<number> {
  const raw = join(DIR, `frame-${frameSeq++}.gray`);
  await ffmpeg(
    ["-hide_banner", "-nostdin", "-y", "-ss", atSec.toFixed(3), "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", raw],
    { timeoutMs: 60_000 },
  );
  const buf = await readFile(raw);
  expect(buf.byteLength).toBeGreaterThan(0);
  let sum = 0;
  for (const b of buf) sum += b;
  await rm(raw, { force: true });
  return sum / buf.byteLength;
}

/** Mean level (dBFS) of one narrow band, optionally inside a time window. */
async function bandDb(media: string, freq: number, win?: { startSec: number; durationSec: number }): Promise<number> {
  const args = ["-hide_banner", "-nostdin"];
  if (win) args.push("-ss", win.startSec.toFixed(3), "-t", win.durationSec.toFixed(3));
  args.push("-i", media, "-af", `bandpass=f=${freq}:width_type=h:w=60,volumedetect`, "-f", "null", "-");
  const { stderr } = await ffmpeg(args, { timeoutMs: 120_000 });
  const m = /mean_volume:\s*(-?[0-9.]+) dB/.exec(stderr);
  if (!m) throw new Error(`volumedetect reported no level for ${freq} Hz: ${stderr.slice(-400)}`);
  return Number(m[1]);
}

function params(patch: Record<string, unknown>): EditParams {
  return applyEditPatch(defaultEditParams(), patch);
}

const SRC_FACTS = { width: 360, height: 640, durationSec: 12, hasAudio: true };
const SHORT_FACTS = { width: 320, height: 568, durationSec: 2, hasAudio: false };

interface RenderOpts {
  name: string;
  source: string;
  facts: { width: number; height: number; durationSec: number | null; hasAudio: boolean };
  patch?: Record<string, unknown>;
  audioPaths?: string[];
  subtitlePath?: string | null;
  quality?: "preview" | "export";
  cwd?: string;
}

/** Build args from validated params, run the real encoder, return the output. */
async function render(opts: RenderOpts): Promise<{ out: string; args: string[]; graph: string; expected: number | null }> {
  const p = params(opts.patch ?? {});
  const out = join(DIR, opts.name);
  const built = buildRenderArgs({
    sourcePath: opts.source,
    audioPaths: opts.audioPaths ?? [],
    subtitlePath: opts.subtitlePath ?? null,
    outputPath: out,
    params: p,
    source: opts.facts,
    quality: opts.quality ?? "preview",
  });
  await ffmpeg(built.args, { timeoutMs: 300_000, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  const gi = built.args.indexOf("-filter_complex");
  return { out, args: built.args, graph: built.args[gi + 1] ?? "", expected: built.expectedDurationSec };
}

const ASS_SIZE = { width: 360, height: 640 };

function assFor(cues: SubtitleCue[], preset: SubtitlePreset = "clean-white", size = ASS_SIZE): string {
  return buildAssFile(cues, { ...size, style: applyPreset(preset) });
}

beforeAll(async () => {
  DIR = await mkdtemp(join(tmpdir(), "qa-video-"));
  STORE_ROOT = join(DIR, "storage");
  await mkdir(STORE_ROOT, { recursive: true });
  process.env.MEDIA_STORAGE_DIR = STORE_ROOT;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.STORAGE_DRIVER;
  _resetStorageDriver();

  // lavfi's sine source is 1/8 full scale, so `volume=4` lands it at -6 dBFS —
  // loud enough that mixing two of them cannot clip and loud enough to cross
  // the ducking compressor's fixed 0.05 threshold.
  SRC12 = await gen("src12.mp4", [
    "-f", "lavfi", "-i", "color=c=black:s=360x640:r=30:d=12",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12,volume=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-b:a", "128k", "-shortest",
  ]);
  SPEECH12 = await gen("speech12.mp4", [
    "-f", "lavfi", "-i", "color=c=black:s=360x640:r=30:d=12",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=12,volume=4,volume='if(between(t,4,8),1,0)':eval=frame",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-b:a", "128k", "-shortest",
  ]);
  MUSIC12 = await gen("music12.wav", [
    "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000:duration=12,volume=4", "-c:a", "pcm_s16le",
  ]);
  SHORT2 = await gen("short2.mp4", [
    "-f", "lavfi", "-i", "color=c=black:s=320x568:r=25:d=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
  ]);
  CUTS8 = await gen("cuts8.mp4", [
    "-f", "lavfi", "-i", "color=c=black:s=320x568:r=25:d=2",
    "-f", "lavfi", "-i", "color=c=white:s=320x568:r=25:d=2",
    "-f", "lavfi", "-i", "color=c=black:s=320x568:r=25:d=2",
    "-f", "lavfi", "-i", "color=c=white:s=320x568:r=25:d=2",
    "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000:duration=8,volume=4",
    "-filter_complex", "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]",
    "-map", "[v]", "-map", "4:a", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-c:a", "aac", "-shortest",
  ]);
}, 300_000);

afterAll(async () => {
  if (DIR) await rm(DIR, { recursive: true, force: true }).catch(() => {});
});

// =====================================================================
// 1. The render pipeline, executed for real
// =====================================================================

describe("render pipeline (real FFmpeg)", () => {
  it("encodes validated parameters into a file whose real duration, size and streams match", async () => {
    const { out, expected } = await render({
      name: "pipeline-export.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      patch: { video: { aspect: "9:16", fit: "cover" } },
      quality: "export",
    });

    expect(expected).toBeCloseTo(12, 3);

    const probe = await probeFile(out);
    expect(probe.durationSec).not.toBeNull();
    expect(probe.durationSec!).toBeGreaterThan(11.8);
    expect(probe.durationSec!).toBeLessThan(12.3);
    expect(probe.displayWidth).toBe(360);
    expect(probe.displayHeight).toBe(640);
    expect(probe.video?.codec).toBe("h264");
    expect(probe.video?.pixFmt).toBe("yuv420p");
    expect(probe.audio?.codec).toBe("aac");
    expect(probe.audio?.sampleRate).toBe(48_000);
    expect(probe.formatName ?? "").toContain("mp4");
  }, 180_000);

  it("pads rather than crops in contain mode, producing the square frame it promised", async () => {
    const p = params({ video: { aspect: "1:1", fit: "contain", padColor: "#000000" } });
    expect(resolveTargetSize(p, { width: 360, height: 640 }, "preview")).toEqual({ width: 640, height: 640 });

    const { out, graph } = await render({
      name: "contain.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      patch: { video: { aspect: "1:1", fit: "contain", trim: { startSec: 0, endSec: 2 } } },
    });
    expect(graph).toContain("force_original_aspect_ratio=decrease");
    expect(graph).toContain("pad=640:640");

    const probe = await probeFile(out);
    expect(probe.displayWidth).toBe(640);
    expect(probe.displayHeight).toBe(640);
  }, 180_000);

  it("produces the trimmed, sped-up duration the progress bar is measured against", async () => {
    const p = params({ video: { trim: { startSec: 4, endSec: 10 }, speed: 2 } });
    expect(effectiveDuration(p, 12)).toBeCloseTo(3, 6);

    const { out } = await render({
      name: "trimspeed.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      patch: { video: { trim: { startSec: 4, endSec: 10 }, speed: 2 } },
    });
    const probe = await probeFile(out);
    expect(probe.durationSec!).toBeGreaterThan(2.9);
    expect(probe.durationSec!).toBeLessThan(3.2);
  }, 180_000);

  it("rejects a file that is not media at all, before anything else touches it", async () => {
    const junk = join(DIR, "not-media.mp4");
    await writeFile(junk, Buffer.from("this is not a video, it only has the extension"));
    await expect(validateUpload(junk, "SOURCE")).rejects.toBeInstanceOf(UnsupportedMediaError);
  }, 60_000);

  it("reads FFmpeg's own progress lines back as seconds", async () => {
    expect(parseProgressSeconds("frame= 120 fps=30 time=00:01:23.45 bitrate=…")).toBeCloseTo(83.45, 3);
    expect(parseProgressSeconds("no timestamp here")).toBeNull();
  });

  it("surfaces a real encoder failure as FfmpegError with the stderr tail", async () => {
    await expect(
      ffmpeg(["-hide_banner", "-nostdin", "-y", "-i", join(DIR, "does-not-exist.mp4"), join(DIR, "nope.mp4")], { timeoutMs: 30_000 }),
    ).rejects.toBeInstanceOf(FfmpegError);
  }, 60_000);
});

// =====================================================================
// 2. Audio: independent levels, mute, ducking
// =====================================================================

describe("audio mixing (measured on the rendered file)", () => {
  /**
   * The product's core promise is that the video's own audio and each uploaded
   * track are separate controls. 30% is an amplitude multiplier, so the
   * original tone must land 20*log10(0.3) = -10.46 dB under the music.
   */
  it("keeps the original at 30% and the music at 100% in one mixed stream", async () => {
    const { out, graph } = await render({
      name: "mix-30-100.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      audioPaths: [MUSIC12],
      patch: { audio: { originalVolume: 30, tracks: [{ assetId: "a1", volume: 100 }] } },
    });

    expect(graph).toContain("[0:a]volume=0.3000");
    expect(graph).toContain("[1:a]volume=1.0000");
    expect(graph).toContain("amix=inputs=2:normalize=0");

    const probe = await probeFile(out);
    expect(probe.audio).not.toBeNull();

    const original = await bandDb(out, 440);
    const music = await bandDb(out, 1000);
    // Both tones are present…
    expect(original).toBeGreaterThan(-45);
    expect(music).toBeGreaterThan(-20);
    // …and separated by exactly the amount 30% means.
    expect(music - original).toBeGreaterThan(8);
    expect(music - original).toBeLessThan(13);
  }, 240_000);

  it("leaves both tracks untouched at 100/100, proving the gap above came from the setting", async () => {
    const { out } = await render({
      name: "mix-100-100.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      audioPaths: [MUSIC12],
      patch: { audio: { originalVolume: 100, tracks: [{ assetId: "a1", volume: 100 }] } },
    });
    const original = await bandDb(out, 440);
    const music = await bandDb(out, 1000);
    expect(Math.abs(music - original)).toBeLessThan(1.5);
  }, 240_000);

  it("removes the original entirely when it is muted, keeping the uploaded track", async () => {
    const { out, graph } = await render({
      name: "mix-muted.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      audioPaths: [MUSIC12],
      patch: { audio: { muteOriginal: true, tracks: [{ assetId: "a1", volume: 100 }] } },
    });

    expect(graph).not.toContain("[0:a]");
    const original = await bandDb(out, 440);
    const music = await bandDb(out, 1000);
    expect(music).toBeGreaterThan(-20);
    expect(music - original).toBeGreaterThan(20);
  }, 240_000);

  it("drops the music while the original is loud, and only then (ducking)", async () => {
    const ducked = await render({
      name: "duck-on.mp4",
      source: SPEECH12,
      facts: SRC_FACTS,
      audioPaths: [MUSIC12],
      patch: { audio: { originalVolume: 30, tracks: [{ assetId: "a1", volume: 100, duckUnderSpeech: true }] } },
    });
    expect(ducked.graph).toContain("sidechaincompress");
    expect(ducked.graph).toContain("asplit=2[a_orig_mix][a_key]");

    const plain = await render({
      name: "duck-off.mp4",
      source: SPEECH12,
      facts: SRC_FACTS,
      audioPaths: [MUSIC12],
      patch: { audio: { originalVolume: 30, tracks: [{ assetId: "a1", volume: 100, duckUnderSpeech: false }] } },
    });
    expect(plain.graph).not.toContain("sidechaincompress");

    const quietWindow = { startSec: 1, durationSec: 2 }; // the source is silent here
    const loudWindow = { startSec: 5, durationSec: 2 }; // the source's tone is playing

    const duckQuiet = await bandDb(ducked.out, 1000, quietWindow);
    const duckLoud = await bandDb(ducked.out, 1000, loudWindow);
    const plainQuiet = await bandDb(plain.out, 1000, quietWindow);
    const plainLoud = await bandDb(plain.out, 1000, loudWindow);

    // With ducking the music really is pushed down under the speech…
    expect(duckQuiet - duckLoud).toBeGreaterThan(3);
    // …and without it the same two windows are indistinguishable.
    expect(Math.abs(plainQuiet - plainLoud)).toBeLessThan(1.5);
  }, 300_000);
});

// =====================================================================
// 3. Subtitle re-timing, proven against the pixels of the output
// =====================================================================

describe("subtitle re-timing under trim + speed", () => {
  const CUE: SubtitleCue[] = [{ start: 6, end: 7, text: "CUEMARK" }];
  const TRIM = { trimStartSec: 4, trimEndSec: 10, speed: 2 };

  it("maps source time to output time as (t - trimStart) / speed", () => {
    const retimed = retimeCues(CUE, TRIM);
    expect(retimed).toHaveLength(1);
    expect(retimed[0]!.start).toBeCloseTo(1, 6);
    expect(retimed[0]!.end).toBeCloseTo(1.5, 6);
  });

  it("burns the cue at the retimed moment in the real output, and nowhere else", async () => {
    const retimed = retimeCues(CUE, TRIM);
    const assPath = join(DIR, "retimed.ass");
    await writeFile(assPath, assFor(retimed), "utf8");

    const { out } = await render({
      name: "retimed.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      subtitlePath: assPath,
      patch: {
        video: { trim: { startSec: 4, endSec: 10 }, speed: 2 },
        subtitles: { trackId: "t1", burnIn: true },
      },
    });

    const probe = await probeFile(out);
    expect(probe.durationSec!).toBeGreaterThan(2.9);
    expect(probe.durationSec!).toBeLessThan(3.2);

    // Inside the retimed window the caption is on screen.
    expect(await ink(out, 1.2)).toBeGreaterThan(0.5);
    expect(await ink(out, 1.4)).toBeGreaterThan(0.5);
    // Outside it, the frame is untouched black.
    expect(await ink(out, 0.3)).toBeLessThan(0.02);
    expect(await ink(out, 0.8)).toBeLessThan(0.02);
    expect(await ink(out, 1.8)).toBeLessThan(0.02);
    expect(await ink(out, 2.5)).toBeLessThan(0.02);
  }, 240_000);

  it("shows the shipped bug's shape: without re-timing the caption never appears at all", async () => {
    // The stored cue sits at 6-7 s of the SOURCE. The output is only ~3 s long,
    // so burning the un-retimed cue loses the caption entirely — silently.
    const assPath = join(DIR, "not-retimed.ass");
    await writeFile(assPath, assFor(CUE), "utf8");

    const { out } = await render({
      name: "not-retimed.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      subtitlePath: assPath,
      patch: {
        video: { trim: { startSec: 4, endSec: 10 }, speed: 2 },
        subtitles: { trackId: "t1", burnIn: true },
      },
    });

    for (const t of [0.3, 1.2, 1.4, 2.5]) {
      expect(await ink(out, t)).toBeLessThan(0.02);
    }
  }, 240_000);

  it("drops cues that fall outside the kept range and clips the ones that straddle it", () => {
    const cues: SubtitleCue[] = [
      { start: 0, end: 2, text: "before" },
      { start: 3, end: 5, text: "straddles the in-point" },
      { start: 6, end: 7, text: "inside" },
      { start: 11, end: 12, text: "after" },
    ];
    const out = retimeCues(cues, TRIM);
    expect(out.map((c) => c.text)).toEqual(["straddles the in-point", "inside"]);
    expect(out[0]!.start).toBeCloseTo(0, 6); // clipped to the trim start
    expect(out[0]!.end).toBeCloseTo(0.5, 6);
  });

  it("re-times word timings alongside their cue", () => {
    const withWords: SubtitleCue[] = [
      { start: 6, end: 7, text: "two words", words: [{ start: 6, end: 6.5, text: "two" }, { start: 6.5, end: 7, text: "words" }] },
    ];
    const out = retimeCues(withWords, TRIM);
    expect(out[0]!.words).toHaveLength(2);
    expect(out[0]!.words![0]!.start).toBeCloseTo(1, 6);
    expect(out[0]!.words![1]!.end).toBeCloseTo(1.5, 6);
  });

  it("is a no-op when nothing moved the timeline", () => {
    expect(retimeCues(CUE, { speed: 1 })).toBe(CUE);
  });
});

// =====================================================================
// 4. Subtitle presets, glyphs and hostile caption text
// =====================================================================

describe("subtitle presets", () => {
  const styleLine = (ass: string) => ass.split("\n").find((l) => l.startsWith("Style: Default,")) ?? "";

  it("gives every preset a distinct ASS style line", () => {
    const lines = SUBTITLE_PRESETS.map((p) => styleLine(assFor([{ start: 0.5, end: 1.5, text: "Preset" }], p)));
    for (const line of lines) expect(line.length).toBeGreaterThan(40);
    expect(new Set(lines).size).toBe(SUBTITLE_PRESETS.length);
  });

  it("renders every preset onto real frames, visible only inside the cue", async () => {
    for (const preset of SUBTITLE_PRESETS) {
      const assPath = join(DIR, `preset-${preset}.ass`);
      await writeFile(assPath, assFor([{ start: 0.5, end: 1.5, text: "Preset check" }], preset, { width: 320, height: 568 }), "utf8");
      const { out } = await render({
        name: `preset-${preset}.mp4`,
        source: SHORT2,
        facts: SHORT_FACTS,
        subtitlePath: assPath,
        patch: { subtitles: { trackId: "t1", burnIn: true } },
      });
      expect(await ink(out, 1.0)).toBeGreaterThan(0.3);
      expect(await ink(out, 0.1)).toBeLessThan(0.02);
    }
  }, 300_000);

  it("draws a background box for the box presets and not for the outline ones", () => {
    // Style fields: Name, Fontname, Fontsize, 4 colours, Bold, Italic,
    // Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle → 15.
    const borderStyle = (preset: SubtitlePreset) => styleLine(assFor([{ start: 0, end: 1, text: "x" }], preset)).split(",")[15];
    expect(borderStyle("high-contrast")).toBe("3");
    expect(borderStyle("professional")).toBe("3");
    expect(borderStyle("clean-white")).toBe("1");
    expect(borderStyle("bold-social")).toBe("1");
  });
});

describe("Uzbek and Cyrillic burn-in", () => {
  async function burn(name: string, text: string): Promise<string> {
    const assPath = join(DIR, `${name}.ass`);
    const ass = assFor([{ start: 0.5, end: 1.5, text }], "clean-white", { width: 320, height: 568 });
    // The exact codepoints must survive into the file the renderer reads.
    expect(ass).toContain(text);
    await writeFile(assPath, ass, "utf8");
    const { out } = await render({
      name: `${name}.mp4`,
      source: SHORT2,
      facts: SHORT_FACTS,
      subtitlePath: assPath,
      patch: { subtitles: { trackId: "t1", burnIn: true } },
    });
    return out;
  }

  it("draws Cyrillic as real glyphs, not identical .notdef boxes", async () => {
    // Equal character counts. Missing-glyph boxes are all the same rectangle, so
    // tofu would give these two renders near-identical ink; real glyphs cannot.
    const wide = await ink(await burn("cyr-wide", "ЖЖЖЖЖЖ"), 1.0);
    const narrow = await ink(await burn("cyr-narrow", "ІІІІІІ"), 1.0);
    expect(wide).toBeGreaterThan(0.3);
    expect(narrow).toBeGreaterThan(0.05);
    expect(wide / narrow).toBeGreaterThan(1.8);
  }, 300_000);

  it("renders a full Cyrillic sentence including Ё and Щ", async () => {
    expect(await ink(await burn("cyr-sentence", "Привет мир Ёё Щщ"), 1.0)).toBeGreaterThan(0.5);
  }, 240_000);

  it("renders the Uzbek oʻ/gʻ modifier letter rather than dropping it", async () => {
    const marksOnly = await ink(await burn("uz-marks", "ʻʻʻʻʻʻʻʻ"), 1.0);
    expect(marksOnly).toBeGreaterThan(0.02);

    // The same phrase with and without the modifier letters: the marked one must
    // carry strictly more ink, which it cannot if the mark is being swallowed.
    const marked = await ink(await burn("uz-marked", "gʻoʻza qoʻshiq"), 1.0);
    const plain = await ink(await burn("uz-plain", "goza qoshiq"), 1.0);
    expect(marked).toBeGreaterThan(plain);
  }, 300_000);
});

describe("hostile caption text", () => {
  const NASTY =
    `'; rm -rf / ; echo pwned & type NUL > pwned.txt | {\\an8\\pos(0,0)} ` +
    `[0:v]drawtext=text='x':fontcolor=red $(touch pwned2) \`whoami\` "quoted" C:\\Windows`;

  /** An ASS event is 9 comma-separated fields, then the text, which may contain commas. */
  const eventText = (line: string) => line.split(",").slice(9).join(",");

  it("neutralises braces and backslashes so the text cannot become ASS override tags", () => {
    const ass = assFor([{ start: 0.5, end: 1.5, text: NASTY }]);
    const dialogue = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogue).toHaveLength(1);
    const body = eventText(dialogue[0]!);

    // `{` opens an override block and `\` starts an escape — both must be gone.
    expect(body).not.toContain("{");
    expect(body).not.toContain("}");
    expect(body.replace(/\\N/g, "")).not.toContain("\\");
    // It is still the operator's words, not a blank line.
    expect(body).toContain("rm -rf /");
    expect(body).toContain("drawtext=text=");
    // The override the text tried to open survives only as inert punctuation.
    expect(body).toContain("(∖an8∖pos(0,0))");
  });

  it("cannot inject an extra Dialogue event through a newline in the text", () => {
    const injected = "hello\nDialogue: 0,0:00:00.00,9:59:59.99,Default,,0,0,0,,INJECTED";
    const ass = assFor([{ start: 0.5, end: 1.5, text: injected }]);
    const dialogue = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

    // One event, still the operator's own start/end times.
    expect(dialogue).toHaveLength(1);
    expect(dialogue[0]!.startsWith("Dialogue: 0,0:00:00.50,0:00:01.50,Default,,0,0,0,,")).toBe(true);
    // The forged timing only ever appears inside the text of that one event.
    expect(ass.split("\n").filter((l) => l.startsWith("Dialogue: 0,0:00:00.00"))).toHaveLength(0);
    expect(eventText(dialogue[0]!)).toContain("9:59:59.99");
  });

  it("renders the hostile text literally, executes nothing, and never reaches argv", async () => {
    const assPath = join(DIR, "nasty.ass");
    await writeFile(assPath, assFor([{ start: 0.5, end: 1.5, text: NASTY }], "clean-white", { width: 320, height: 568 }), "utf8");

    const before = await readdir(DIR);
    const { out, args } = await render({
      name: "nasty.mp4",
      source: SHORT2,
      facts: SHORT_FACTS,
      subtitlePath: assPath,
      patch: { subtitles: { trackId: "t1", burnIn: true } },
    });

    // The only thing the graph learned is a path.
    const joined = args.join("\u0000");
    expect(joined).not.toContain("rm -rf");
    expect(joined).not.toContain("drawtext");
    expect(joined).not.toContain("whoami");
    expect(args.filter((a) => a.includes("subtitles="))).toHaveLength(1);

    // Pixels were drawn, so it rendered as text rather than being discarded.
    expect(await ink(out, 1.0)).toBeGreaterThan(0.3);
    expect(await ink(out, 0.1)).toBeLessThan(0.02);

    // Nothing the text asked for happened.
    const after = await readdir(DIR);
    const created = after.filter((f) => !before.includes(f));
    expect(created.some((f) => /pwned/i.test(f))).toBe(false);
    expect(existsSync(join(DIR, "pwned.txt"))).toBe(false);
    expect(existsSync(join(DIR, "pwned2"))).toBe(false);
  }, 240_000);

  it("escapes a filesystem path for the filtergraph without touching the caption text", () => {
    expect(escapeFilterPath("C:\\Users\\me\\subs.ass")).toBe("C\\:/Users/me/subs.ass");
    expect(escapeFilterPath("/tmp/a[b]c.ass")).toBe("/tmp/a\\[b\\]c.ass");
  });
});

// =====================================================================
// 5. Thumbnail and 16 kHz audio extraction
// =====================================================================

describe("derived media", () => {
  it("extracts a single JPEG frame at the requested width", async () => {
    const outPath = join(DIR, "thumb.jpg");
    await ffmpeg(buildThumbnailArgs(SRC12, outPath, 3, 720), { timeoutMs: 120_000 });

    const probe = await probeFile(outPath);
    expect(probe.video?.width).toBe(720);
    expect(probe.video?.height).toBe(1280); // -2 keeps the 9:16 shape, even
    expect(probe.audio).toBeNull();
    expect((await stat(outPath)).size).toBeGreaterThan(500);
  }, 120_000);

  it("clamps a negative timestamp instead of handing FFmpeg a bad seek", async () => {
    const args = buildThumbnailArgs(SRC12, join(DIR, "thumb0.jpg"), -5, 320);
    expect(args[args.indexOf("-ss") + 1]).toBe("0.000");
    await ffmpeg(args, { timeoutMs: 120_000 });
    expect(existsSync(join(DIR, "thumb0.jpg"))).toBe(true);
  }, 120_000);

  it("extracts 16 kHz mono PCM for transcription", async () => {
    const outPath = join(DIR, "stt.wav");
    await ffmpeg(buildAudioExtractArgs(SRC12, outPath, { startSec: 2, durationSec: 4 }), { timeoutMs: 120_000 });

    const probe = await probeFile(outPath);
    expect(probe.audio?.codec).toBe("pcm_s16le");
    expect(probe.audio?.channels).toBe(1);
    expect(probe.audio?.sampleRate).toBe(16_000);
    expect(probe.video).toBeNull();
    expect(probe.durationSec!).toBeGreaterThan(3.9);
    expect(probe.durationSec!).toBeLessThan(4.2);
    // 16 kHz * 2 bytes * 4 s, plus the header.
    expect((await stat(outPath)).size).toBeGreaterThan(120_000);
    expect((await stat(outPath)).size).toBeLessThan(140_000);
  }, 120_000);
});

// =====================================================================
// 6. Sample analysis
// =====================================================================

describe("sample analysis (measured, not guessed)", () => {
  it("finds the scene cuts that are really in the clip and reads its pacing", async () => {
    const measured = await measureSample(CUTS8);

    expect(measured.durationSec!).toBeGreaterThan(7.8);
    expect(measured.durationSec!).toBeLessThan(8.3);
    expect(measured.width).toBe(320);
    expect(measured.height).toBe(568);
    expect(measured.aspectLabel).toBe("9:16");
    expect(measured.hasAudio).toBe(true);

    // The fixture changes black->white->black->white every 2 s.
    expect(measured.cutCount).toBe(3);
    expect(measured.sceneCuts).toEqual([2, 4, 6]);
    expect(measured.medianCutSec).toBeCloseTo(2, 2);
    expect(measured.pacing).toBe("medium");

    expect(measured.loudnessLufs).not.toBeNull();
    expect(measured.detectedCrop).toBe("320:568:0:0");
    // A continuous tone means no silence, so it reads as all "speech".
    expect(measured.speechRatio).toBeCloseTo(1, 2);
  }, 300_000);

  it("reports no audio facts for a clip that has no audio", async () => {
    const measured = await measureSample(SHORT2);
    expect(measured.hasAudio).toBe(false);
    expect(measured.loudnessLufs).toBeNull();
    expect(measured.silenceWindows).toEqual([]);
  }, 180_000);
});

describe("editing plan feasibility", () => {
  const measured: MeasuredStyle = {
    durationSec: 15,
    width: 1080,
    height: 1920,
    aspectLabel: "9:16",
    fps: 30,
    hasAudio: true,
    sceneCuts: [1, 2, 3, 4.5],
    cutCount: 4,
    medianCutSec: 1.1,
    pacing: "fast",
    loudnessLufs: -13.5,
    silenceWindows: [{ start: 0, end: 12 }],
    speechRatio: 0.2,
    detectedCrop: null,
  };
  const observed: ObservedStyle = {
    hasSubtitles: true,
    subtitlePosition: "lower-center",
    subtitleStyleGuess: "big bold white caps",
    colorTreatment: "vivid",
    pacingDescription: "quick cuts",
    notableEffects: ["tracked logo follows the subject"],
    summary: "Fast vertical edit.",
  };
  const plan = buildEditingPlan(measured, observed, { width: 1080, height: 1920, durationSec: 60 });

  it("separates what it will reproduce from what it only approximates and what it refuses", () => {
    const levels = new Set(plan.map((p) => p.feasibility));
    expect(levels).toEqual(new Set(["reproducible", "approximate", "unsupported"]));
    expect(plan.find((p) => p.op === "aspect")?.feasibility).toBe("reproducible");
    expect(plan.find((p) => p.op === "look")?.feasibility).toBe("approximate");
    expect(plan.find((p) => p.op === "pacing")?.feasibility).toBe("unsupported");
    expect(plan.find((p) => p.op === "effect")?.label).toBe("tracked logo follows the subject");
  });

  it("gives an unsupported item no applicable patch, so accepting it changes nothing", () => {
    const unsupported = plan.filter((p) => p.feasibility === "unsupported");
    expect(unsupported.length).toBeGreaterThan(0);
    for (const item of unsupported) expect(item.patch).toBeUndefined();

    const before = defaultEditParams();
    const after = applyEditPatch(before, planPatch(plan, unsupported.map((p) => p.op)));
    expect(after).toEqual(before);
  });

  it("applies only the accepted items, and the result still validates", () => {
    const patch = planPatch(plan, ["aspect", "look", "music"]);
    const next = applyEditPatch(defaultEditParams(), patch);
    expect(editParamsSchema.safeParse(next).success).toBe(true);
    expect(next.video.aspect).toBe("9:16");
    expect(next.look.preset).toBe("vivid");
    expect(next.audio.originalVolume).toBe(25);
    // "trim" was never accepted, so the timeline is untouched.
    expect(next.video.trim).toBeUndefined();
  });

  it("produces nothing unsupported can smuggle in: every patch parses as real parameters", () => {
    for (const item of plan) {
      if (!item.patch) continue;
      expect(() => applyEditPatch(defaultEditParams(), item.patch)).not.toThrow();
    }
  });
});

// =====================================================================
// 7. Local storage driver
// =====================================================================

describe("local storage driver — streaming writes", () => {
  function chunkStream(count: number, size: number, produced: number[]): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= count) {
          controller.close();
          return;
        }
        produced.push(i);
        controller.enqueue(new Uint8Array(size).fill(65 + (i % 26)));
        i += 1;
      },
    });
  }

  it("writes the whole body and leaves no .part behind", async () => {
    const driver = new LocalDriver();
    const produced: number[] = [];
    const res = await driver.putStream("video/acc1/source/ok.bin", chunkStream(4, 1024, produced), {
      contentType: "application/octet-stream",
      maxBytes: 1024 * 1024,
    });

    expect(res.sizeBytes).toBe(4096);
    const path = join(STORE_ROOT, "video/acc1/source/ok.bin");
    expect((await stat(path)).size).toBe(4096);
    expect(existsSync(`${path}.part`)).toBe(false);

    const bytes = await driver.readAll("video/acc1/source/ok.bin");
    expect(bytes.byteLength).toBe(4096);
    expect(bytes[0]).toBe(65);
    expect(bytes[3072]).toBe(68); // fourth chunk
  });

  it("aborts at the limit, deletes the partial file, and never reads the rest of the body", async () => {
    const driver = new LocalDriver();
    const produced: number[] = [];
    const key = "video/acc1/source/too-big.bin";

    await expect(
      driver.putStream(key, chunkStream(50, 1024, produced), { contentType: "application/octet-stream", maxBytes: 4096 }),
    ).rejects.toBeInstanceOf(UploadTooLargeError);

    // Five 1 KB chunks cross a 4 KB limit; the stream's own prefetch may pull
    // one more. Forty-plus chunks must never have been asked for.
    expect(produced.length).toBeGreaterThanOrEqual(5);
    expect(produced.length).toBeLessThanOrEqual(6);

    const path = join(STORE_ROOT, key);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.part`)).toBe(false);
  });

  it("honours an abort signal and cleans up", async () => {
    const driver = new LocalDriver();
    const produced: number[] = [];
    const controller = new AbortController();
    controller.abort();
    const key = "video/acc1/source/aborted.bin";

    await expect(
      driver.putStream(key, chunkStream(10, 1024, produced), {
        contentType: "application/octet-stream",
        maxBytes: 1024 * 1024,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(StorageError);

    // At most the stream's own one-chunk prefetch; nothing was written.
    expect(produced.length).toBeLessThanOrEqual(1);
    expect(existsSync(join(STORE_ROOT, key))).toBe(false);
    expect(existsSync(`${join(STORE_ROOT, key)}.part`)).toBe(false);
  });

  /**
   * The orphan this guards against was a RACE, not a certainty: the descriptor
   * for the `.part` opens asynchronously, so an unlink issued straight after
   * destroy() could run first and the file would then appear behind it. One
   * attempt reproduced it only about two thirds of the time, so one attempt is
   * not a regression test. Twenty-five cancelled uploads make a reintroduction
   * effectively certain to be caught, and the store is re-read after a tick so
   * a file that materialises late is still counted.
   */
  it("leaves no orphaned .part behind over many cancelled uploads", async () => {
    const driver = new LocalDriver();
    const keys: string[] = [];

    for (let i = 0; i < 25; i += 1) {
      const key = `video/acc1/source/cancel-${i}.bin`;
      keys.push(key);
      const controller = new AbortController();
      controller.abort();
      await expect(
        driver.putStream(key, chunkStream(10, 1024, []), {
          contentType: "application/octet-stream",
          maxBytes: 1024 * 1024,
          signal: controller.signal,
        }),
      ).rejects.toBeInstanceOf(StorageError);
    }

    await new Promise((r) => setTimeout(r, 250));
    const orphans = keys.filter((k) => existsSync(`${join(STORE_ROOT, k)}.part`));
    expect(orphans).toEqual([]);
    expect(keys.filter((k) => existsSync(join(STORE_ROOT, k)))).toEqual([]);
  });

  it("cleans up when the upload is cancelled midway, not just before it starts", async () => {
    const driver = new LocalDriver();
    const key = "video/acc1/source/mid-cancel.bin";
    const controller = new AbortController();
    let pulled = 0;

    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        pulled += 1;
        // Real shape of a client disconnect: bytes have already landed in the
        // .part before the abort arrives.
        if (pulled === 4) controller.abort();
        ctrl.enqueue(new Uint8Array(64 * 1024).fill(7));
      },
    });

    await expect(
      driver.putStream(key, body, {
        contentType: "application/octet-stream",
        maxBytes: 100 * 1024 * 1024,
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(StorageError);

    await new Promise((r) => setTimeout(r, 150));
    expect(existsSync(join(STORE_ROOT, key))).toBe(false);
    expect(existsSync(`${join(STORE_ROOT, key)}.part`)).toBe(false);
    // It stopped pulling; it did not drain the rest of the body.
    expect(pulled).toBeLessThanOrEqual(6);
  });

  /**
   * A large upload pauses for backpressure many times. Attaching a fresh error
   * listener on each pause and never removing it leaks one per pause; past ten
   * Node prints a MaxListenersExceededWarning, which in production logs is
   * indistinguishable from a genuine handle leak. The write must complete with
   * its listener count flat.
   */
  it("does not leak a listener per backpressure pause on a large body", async () => {
    const driver = new LocalDriver();
    const key = "video/acc1/source/backpressure.bin";
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(`${w.name}: ${w.message}`);
    process.on("warning", onWarning);

    // 64 KB is the default highWaterMark, so 200 chunks of it force many real
    // pauses rather than a single buffered write.
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (i >= 200) {
          ctrl.close();
          return;
        }
        i += 1;
        ctrl.enqueue(new Uint8Array(64 * 1024).fill(9));
      },
    });

    try {
      const res = await driver.putStream(key, body, {
        contentType: "application/octet-stream",
        maxBytes: 64 * 1024 * 1024,
      });
      expect(res.sizeBytes).toBe(200 * 64 * 1024);
      expect((await stat(join(STORE_ROOT, key))).size).toBe(200 * 64 * 1024);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      process.removeListener("warning", onWarning);
    }

    expect(warnings.filter((w) => w.includes("MaxListenersExceeded"))).toEqual([]);
  });

  it("serves a byte range from the middle of a stored object", async () => {
    const driver = new LocalDriver();
    await driver.put("video/acc1/export/range.bin", Buffer.from("0123456789"), { contentType: "application/octet-stream" });
    const stream = await driver.read("video/acc1/export/range.bin", { start: 3, end: 6 });
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    expect(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString()).toBe("3456");
  });

  it("refuses a key that would escape the storage root", async () => {
    const driver = new LocalDriver();
    expect(() => assertSafeKey("../../etc/passwd")).toThrow(StorageError);
    expect(() => driver.localPath("../escape.bin")).toThrow(StorageError);
    await expect(driver.readAll("video/../../escape.bin")).rejects.toBeInstanceOf(StorageError);
  });

  it("reports a missing object as absent rather than throwing", async () => {
    const driver = new LocalDriver();
    expect(await driver.stat("video/acc1/source/missing.bin")).toBeNull();
  });
});

// =====================================================================
// 8. HTTP range parsing and upload guards
// =====================================================================

/**
 * The Blob driver is what runs on a serverless deployment, and it must refuse
 * an over-long upload the same way the local one does — the upload route picks
 * 413 over 500 with `err instanceof UploadTooLargeError`, so the class of the
 * error IS the behaviour.
 *
 * `fetch` is stubbed, but the stub is not what is under test: it consumes the
 * real ReadableStream the driver built (so the driver's own counting transform
 * decides what happens) and it reproduces undici's documented shape for a body
 * that throws — reject with `TypeError: fetch failed` carrying the real error
 * on `.cause`. That shape was verified against a real fetch against a local
 * HTTP server before this test was written.
 */
describe("vercel blob driver — upload limits", () => {
  const realFetch = globalThis.fetch;

  function stubFetch() {
    const seen = { bytes: 0, deleted: [] as string[] };
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      if (method === "DELETE" || href.includes("/delete")) {
        seen.deleted.push(href);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      // Drain the body the driver handed us, exactly as the network would.
      const body = init?.body as ReadableStream<Uint8Array> | undefined;
      if (body && typeof body.getReader === "function") {
        const reader = body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) seen.bytes += value.byteLength;
          }
        } catch (cause) {
          throw Object.assign(new TypeError("fetch failed"), { cause });
        }
      }
      return new Response(JSON.stringify({ url: "https://blob.test/obj", pathname: "k" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return seen;
  }

  function chunks(count: number, size: number): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= count) {
          c.close();
          return;
        }
        i += 1;
        c.enqueue(new Uint8Array(size).fill(3));
      },
    });
  }

  beforeEach(() => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test_token";
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    delete process.env.BLOB_READ_WRITE_TOKEN;
  });

  it("uploads a body that fits and reports the real byte count", async () => {
    const seen = stubFetch();
    const res = await new VercelBlobDriver().putStream("video/acc1/source/ok.bin", chunks(4, 1024), {
      contentType: "application/octet-stream",
      maxBytes: 1024 * 1024,
    });
    expect(res.sizeBytes).toBe(4096);
    expect(seen.bytes).toBe(4096);
    expect(res.publicUrl).toBe("https://blob.test/obj");
    globalThis.fetch = realFetch;
  });

  it("refuses an over-long upload as UploadTooLargeError, not a generic fetch failure", async () => {
    const seen = stubFetch();
    const driver = new VercelBlobDriver();

    const err = await driver
      .putStream("video/acc1/source/big.bin", chunks(50, 1024), {
        contentType: "application/octet-stream",
        maxBytes: 4096,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    // This is the assertion the upload route's 413 depends on.
    expect(err).toBeInstanceOf(UploadTooLargeError);
    expect((err as Error).name).toBe("UploadTooLargeError");
    expect((err as Error).message).not.toContain("fetch failed");
    // The relay really did stop; it did not stream all 50 KB to Blob.
    expect(seen.bytes).toBeLessThanOrEqual(4096);
    globalThis.fetch = realFetch;
  });

  it("leaves a genuine network failure as the network failure it is", async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("ECONNRESET") });
    }) as typeof fetch;

    const err = await new VercelBlobDriver()
      .putStream("video/acc1/source/net.bin", chunks(1, 16), { contentType: "application/octet-stream", maxBytes: 1024 })
      .then(
        () => null,
        (e: unknown) => e,
      );

    // Must NOT be re-labelled as the client's fault — that would turn an outage
    // into a 413 telling the operator their file is too big.
    expect(err).not.toBeInstanceOf(UploadTooLargeError);
    expect((err as Error).message).toContain("fetch failed");
    globalThis.fetch = realFetch;
  });
});

describe("parseByteRange", () => {
  const TOTAL = 1000;

  it("reads a suffix range as the LAST bytes", () => {
    expect(parseByteRange("bytes=-500", TOTAL)).toEqual({ kind: "ok", range: { start: 500, end: 999 } });
  });

  it("serves the whole object when the suffix is longer than the file", () => {
    expect(parseByteRange("bytes=-5000", TOTAL)).toEqual({ kind: "ok", range: { start: 0, end: 999 } });
  });

  it("handles the open-ended form", () => {
    expect(parseByteRange("bytes=500-", TOTAL)).toEqual({ kind: "ok", range: { start: 500, end: 999 } });
    expect(parseByteRange("bytes=0-", TOTAL)).toEqual({ kind: "ok", range: { start: 0, end: 999 } });
  });

  it("handles an explicit range and clamps its end to the object", () => {
    expect(parseByteRange("bytes=0-99", TOTAL)).toEqual({ kind: "ok", range: { start: 0, end: 99 } });
    expect(parseByteRange("bytes=900-99999", TOTAL)).toEqual({ kind: "ok", range: { start: 900, end: 999 } });
    expect(parseByteRange("  bytes = 10-20 ", TOTAL)).toEqual({ kind: "ok", range: { start: 10, end: 20 } });
    expect(parseByteRange("BYTES=10-20", TOTAL)).toEqual({ kind: "ok", range: { start: 10, end: 20 } });
  });

  it("reports the forms it cannot satisfy", () => {
    expect(parseByteRange("bytes=1000-", TOTAL)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=2000-3000", TOTAL)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=-0", TOTAL)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=0-10", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("falls back to the whole object for anything else", () => {
    for (const header of [
      null,
      undefined,
      "",
      "items=0-10",
      "bytes=",
      "bytes=-",
      "bytes=abc-def",
      "bytes=100-50",
      "bytes=0-10,20-30", // multipart/byteranges is not served
      "bytes=1 0-20", // RFC 9110 forbids space inside a spec; whole object is the safe answer
    ]) {
      expect(parseByteRange(header, TOTAL)).toEqual({ kind: "ignore" });
    }
  });
});

describe("upload concurrency slots", () => {
  beforeEach(() => _resetUploadSlots());

  it("lets one operator fill the editor's three zones and refuses a fourth", () => {
    const mine = [acquireUploadSlot("admin-1"), acquireUploadSlot("admin-1"), acquireUploadSlot("admin-1")];
    expect(mine.every(Boolean)).toBe(true);
    expect(acquireUploadSlot("admin-1")).toBeNull();
    expect(uploadsInFlight()).toBe(3);

    mine[0]!.release();
    expect(uploadsInFlight()).toBe(2);
    expect(acquireUploadSlot("admin-1")).not.toBeNull();
  });

  it("caps the process below three operators' worth", () => {
    const a = [acquireUploadSlot("a"), acquireUploadSlot("a"), acquireUploadSlot("a")];
    expect(a.every(Boolean)).toBe(true);
    const b1 = acquireUploadSlot("b");
    expect(b1).not.toBeNull(); // 4th overall
    expect(acquireUploadSlot("b")).toBeNull(); // process total reached
    expect(uploadsInFlight()).toBe(4);

    b1!.release();
    expect(acquireUploadSlot("b")).not.toBeNull();
  });

  it("ignores a double release instead of inventing a slot", () => {
    const slot = acquireUploadSlot("c")!;
    slot.release();
    slot.release();
    expect(uploadsInFlight()).toBe(0);
    const four = [acquireUploadSlot("c"), acquireUploadSlot("c"), acquireUploadSlot("c"), acquireUploadSlot("d")];
    expect(four.every(Boolean)).toBe(true);
    expect(acquireUploadSlot("e")).toBeNull();
  });

  it("stops reading an oversized body instead of allocating it", async () => {
    const produced: number[] = [];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= 100) {
          controller.close();
          return;
        }
        produced.push(i);
        controller.enqueue(new Uint8Array(1024));
        i += 1;
      },
    });
    await expect(readBoundedBody(body, 4096)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(produced.length).toBeLessThanOrEqual(6);
  });

  it("reads a body that fits, and treats a missing body as empty", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
        controller.close();
      },
    });
    expect([...(await readBoundedBody(body, 1024))]).toEqual([1, 2, 3, 4, 5]);
    expect((await readBoundedBody(null, 1024)).byteLength).toBe(0);
  });
});

// =====================================================================
// 9. Chat assistant
// =====================================================================

describe("assistant language detection", () => {
  it.each([
    ["Bu videoga faqat fon musiqasi qoʻsh, original ovoz 30% saqlansin", "uz"],
    ["Videoni tezroq qil, lekin ovoz tabiiy qolsin", "uz"],
    ["Matnni kattaroq qil", "uz"],
    ["Subtitrlarni pastki qismga joylashtir", "uz"],
    ["Добавь музыку на фон", "ru"],
    ["Сделай субтитры больше", "ru"],
    ["Use this music as background audio and preserve 30% of the original voice", "en"],
    ["Add captions with a black background and white text", "en"],
  ])("detects %j as %s", (text, expected) => {
    expect(detectLanguage(text)).toBe(expected);
  });

  it("does not mistake ordinary English editing words for Uzbek", () => {
    // Every one of these used to come back "uz": the marker list carried the
    // bare fragments `bo` and `qo` plus the word "video", which is English too.
    for (const text of [
      "Make the video 2x faster",
      "Make the caption text bold",
      "Put the captions at the bottom",
      "Boost the music volume",
      "Add a box behind the subtitles",
      "Also trim the first two seconds",
    ]) {
      expect(detectLanguage(text)).toBe("en");
    }
  });
});

describe("assistant patch validation", () => {
  const baseInput = {
    message: "make the music quieter",
    history: [] as Array<{ role: "user" | "assistant"; text: string }>,
    params: defaultEditParams(),
    context: {
      sourceLabel: "clip.mp4",
      audioAssets: [{ id: "asset-music", name: "track.mp3", durationSec: 90 }],
      subtitleInfo: "No subtitle track yet.",
      accountId: "acc1",
      projectId: "prj1",
    },
    model: "test-model",
    provider: "ANTHROPIC" as AIProviderType,
  };

  function reply(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>, text: string | null = null) {
    chatMock.mockResolvedValueOnce({
      text,
      toolCalls: toolCalls.map((c, i) => ({ id: `tc${i}`, ...c })),
      inputTokens: 10,
      outputTokens: 5,
      stopReason: "tool_use",
      costUsd: null,
    });
  }

  beforeEach(() => chatMock.mockReset());

  it("accepts a well-formed proposal and shows it as a diff", async () => {
    reply([{ name: "propose_edit", arguments: { patch: { audio: { originalVolume: 30 } }, summary: "Lower the original to 30%." } }]);
    const turn = await runAssistantTurn(baseInput);

    expect(turn.proposal).not.toBeNull();
    expect(turn.proposal!.next.audio.originalVolume).toBe(30);
    expect(turn.proposal!.changes).toContainEqual({ path: "audio.originalVolume", from: "100", to: "30" });
    // Nothing has been applied: the caller still holds the old parameters.
    expect(baseInput.params.audio.originalVolume).toBe(100);
  });

  it("refuses an out-of-range proposal instead of clamping it into a render", async () => {
    reply([{ name: "propose_edit", arguments: { patch: { video: { speed: 99 } }, summary: "Make it 99x." } }]);
    const turn = await runAssistantTurn(baseInput);

    expect(turn.proposal).toBeNull();
    expect(turn.reply).toMatch(/not in a valid form|rephrase/i);
  });

  it("refuses a proposal that invents a parameter the editor does not have", async () => {
    reply([{ name: "propose_edit", arguments: { patch: { video: { greenScreen: true } }, summary: "Remove the background." } }]);
    const turn = await runAssistantTurn(baseInput);
    expect(turn.proposal).toBeNull();
  });

  it("refuses a filter string smuggled into a field that takes a colour", async () => {
    reply([
      { name: "propose_edit", arguments: { patch: { subtitles: { style: { textColor: "red'; drawtext=text='x" } } }, summary: "Red captions." } },
    ]);
    const turn = await runAssistantTurn(baseInput);
    expect(turn.proposal).toBeNull();
  });

  it("returns no proposal when the patch would change nothing", async () => {
    reply([{ name: "propose_edit", arguments: { patch: { audio: { originalVolume: 100 } }, summary: "Leave it." } }], "Already at 100%.");
    const turn = await runAssistantTurn(baseInput);
    expect(turn.proposal).toBeNull();
    expect(turn.reply).toBe("Already at 100%.");
  });

  it("reports what it will not attempt rather than inventing a parameter", async () => {
    reply([
      {
        name: "explain_unsupported",
        arguments: { requests: ["beat-synced cuts", "animated logo"], explanation: "This editor only does hard cuts." },
      },
    ]);
    const turn = await runAssistantTurn(baseInput);
    expect(turn.unsupported).toEqual(["beat-synced cuts", "animated logo"]);
    expect(turn.proposal).toBeNull();
    expect(turn.reply).toContain("hard cuts");
  });

  it("applies a subtitle preset's whole look, not just its name", async () => {
    reply([{ name: "propose_edit", arguments: { patch: { subtitles: { style: { preset: "high-contrast" } } }, summary: "Boxed captions." } }]);
    const turn = await runAssistantTurn(baseInput);
    expect(turn.proposal).not.toBeNull();
    expect(turn.proposal!.next.subtitles.style.preset).toBe("high-contrast");
    expect(turn.proposal!.next.subtitles.style.backgroundOpacity).toBeCloseTo(0.85, 3);
  });
});

// =====================================================================
// 10. The whole job, end to end: DB row in, encoded file out
// =====================================================================

describe("video job end to end (mock DB, real storage, real FFmpeg)", () => {
  async function seedProject(opts: { jobId: string; kind: "EXPORT" | "PREVIEW"; params: Record<string, unknown>; cues?: SubtitleCue[] }) {
    const key = `video/acc1/source/${opts.jobId}.mp4`;
    const full = join(STORE_ROOT, key);
    await mkdir(dirname(full), { recursive: true });
    await copyFile(SRC12, full);

    store.videoAsset.push({
      id: `src-${opts.jobId}`,
      accountId: "acc1",
      projectId: `prj-${opts.jobId}`,
      role: "SOURCE",
      status: "READY",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: (await stat(full)).size,
      driver: "local",
      storageKey: key,
      durationSec: 12,
      width: 360,
      height: 640,
      hasAudio: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    store.videoProject.push({
      id: `prj-${opts.jobId}`,
      accountId: "acc1",
      title: "QA clip",
      status: "DRAFT",
      sourceAssetId: `src-${opts.jobId}`,
      params: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (opts.cues) {
      store.subtitleTrack.push({
        id: `track-${opts.jobId}`,
        projectId: `prj-${opts.jobId}`,
        cues: opts.cues,
        style: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    store.videoJob.push({
      id: opts.jobId,
      accountId: "acc1",
      projectId: `prj-${opts.jobId}`,
      kind: opts.kind,
      status: "QUEUED",
      params: { params: opts.params },
      progressPct: 0,
      error: null,
      queueJobId: null,
      startedAt: null,
      finishedAt: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  const assetsFor = (jobId: string, role: string) =>
    store.videoAsset.filter((a) => a.projectId === `prj-${jobId}` && a.role === role);

  it("runs an EXPORT from a queued row to a stored, probed, publishable file", async () => {
    const jobId = "vj-export";
    await seedProject({
      jobId,
      kind: "EXPORT",
      params: editParamsSchema.parse({
        video: { trim: { startSec: 4, endSec: 10 }, speed: 2, aspect: "9:16", fit: "cover" },
        audio: { originalVolume: 50 },
        subtitles: { trackId: `track-${jobId}`, burnIn: true },
      }),
      cues: [{ start: 6, end: 7, text: "CUEMARK" }],
    });

    await runVideoJob(jobId);

    const job = store.videoJob.find((j) => j.id === jobId)!;
    expect(job.status).toBe("DONE");
    expect(job.progressPct).toBe(100);
    expect(job.error).toBeNull();

    const exports = assetsFor(jobId, "EXPORT");
    expect(exports).toHaveLength(1);
    const asset = exports[0]!;
    expect(asset.width).toBe(360);
    expect(asset.height).toBe(640);
    expect(asset.driver).toBe("local");
    expect(Number(asset.durationSec)).toBeGreaterThan(2.9);
    expect(Number(asset.durationSec)).toBeLessThan(3.2);
    expect(Number(asset.sizeBytes)).toBeGreaterThan(1000);

    // A cover frame is produced so the export is publishable as a Reel.
    expect(assetsFor(jobId, "THUMBNAIL")).toHaveLength(1);

    const project = store.videoProject.find((p) => p.id === `prj-${jobId}`)!;
    expect(project.status).toBe("READY");
    expect(project.lastExportId).toBe(asset.id);

    // The bytes really are on disk, and the caption landed where re-timing says.
    const stored = join(STORE_ROOT, String(asset.storageKey));
    expect(existsSync(stored)).toBe(true);
    const probe = await probeFile(stored);
    expect(probe.audio?.codec).toBe("aac");
    expect(await ink(stored, 1.2)).toBeGreaterThan(0.5);
    expect(await ink(stored, 0.3)).toBeLessThan(0.02);
    expect(await ink(stored, 2.5)).toBeLessThan(0.02);
  }, 300_000);

  it("burns subtitles even when the scratch directory's path contains an apostrophe", async () => {
    // `os.tmpdir()` is wherever the host says, and a Windows account named
    // O'Brien puts an apostrophe in every temp path. FFmpeg's option grammar has
    // no escaping that survives one inside subtitles='…', so the render used to
    // die with "Unable to open …". Point the workspace at such a directory and
    // require the encode to succeed anyway.
    const awkward = join(DIR, "O'Brien's temp");
    await mkdir(awkward, { recursive: true });
    const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    process.env.TMPDIR = awkward;
    process.env.TMP = awkward;
    process.env.TEMP = awkward;

    try {
      const jobId = "vj-quote";
      await seedProject({
        jobId,
        kind: "PREVIEW",
        params: editParamsSchema.parse({
          video: { trim: { startSec: 4, endSec: 10 }, speed: 2 },
          subtitles: { trackId: `track-${jobId}`, burnIn: true },
        }),
        cues: [{ start: 6, end: 7, text: "CUEMARK" }],
      });

      await runVideoJob(jobId);

      const job = store.videoJob.find((j) => j.id === jobId)!;
      expect(job.error).toBeNull();
      expect(job.status).toBe("DONE");

      const previews = assetsFor(jobId, "PREVIEW");
      expect(previews).toHaveLength(1);
      const stored = join(STORE_ROOT, String(previews[0]!.storageKey));
      expect(await ink(stored, 1.2)).toBeGreaterThan(0.5);
      expect(await ink(stored, 0.3)).toBeLessThan(0.02);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }, 300_000);

  it("marks the job FAILED with a readable reason when the source is gone", async () => {
    const jobId = "vj-missing";
    await seedProject({ jobId, kind: "PREVIEW", params: editParamsSchema.parse({}) });
    const asset = store.videoAsset.find((a) => a.id === `src-${jobId}`)!;
    await rm(join(STORE_ROOT, String(asset.storageKey)), { force: true });

    await expect(runVideoJob(jobId)).rejects.toThrow();

    const job = store.videoJob.find((j) => j.id === jobId)!;
    expect(job.status).toBe("FAILED");
    expect(String(job.error)).toMatch(/Stored file is missing/);
    expect(assetsFor(jobId, "PREVIEW")).toHaveLength(0);
  }, 180_000);

  it("does not store the output of a job that was cancelled while it ran", async () => {
    const jobId = "vj-cancelled";
    await seedProject({ jobId, kind: "PREVIEW", params: editParamsSchema.parse({ video: { trim: { startSec: 0, endSec: 2 } } }) });

    const row = store.videoJob.find((j) => j.id === jobId)!;
    // Cancel the moment the run flips it to RUNNING.
    const watcher = setInterval(() => {
      if (row.status === "RUNNING") {
        row.status = "CANCELLED";
        clearInterval(watcher);
      }
    }, 5);

    await runVideoJob(jobId);
    clearInterval(watcher);

    expect(row.status).toBe("CANCELLED");
    expect(assetsFor(jobId, "PREVIEW")).toHaveLength(0);
  }, 180_000);
});

// =====================================================================
// 11. Audit pass — paths the first suite left open
// =====================================================================

/**
 * Mean value of each channel in one decoded frame. The luma helper above cannot
 * see colour at all, so every claim about the look presets was previously
 * settled by reading the filter string rather than the picture.
 */
async function rgbMeans(video: string, atSec: number): Promise<{ r: number; g: number; b: number }> {
  const raw = join(DIR, `frame-${frameSeq++}.rgb`);
  await ffmpeg(
    ["-hide_banner", "-nostdin", "-y", "-ss", atSec.toFixed(3), "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw],
    { timeoutMs: 60_000 },
  );
  const buf = await readFile(raw);
  expect(buf.byteLength).toBeGreaterThan(0);
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i + 2 < buf.byteLength; i += 3) {
    r += buf[i]!;
    g += buf[i + 1]!;
    b += buf[i + 2]!;
  }
  const n = buf.byteLength / 3;
  await rm(raw, { force: true });
  return { r: r / n, g: g / n, b: b / n };
}

describe("audit: output length against an uploaded audio track", () => {
  /**
   * The realistic case the first suite never built: a short clip with a full
   * song dropped on it. Every mixing test above used a 12 s source against a
   * 12 s "music" file, so the two always ended together and nothing could
   * reveal what happens when they do not.
   *
   * amix runs to its LONGEST input, so the muxed file inherits the song's
   * length: three seconds of video followed by minutes of audio over a frozen
   * last frame. Instagram rejects that, and the operator is never told why.
   */
  it("does not stretch the output to the length of an unlooped music track", async () => {
    const { out, expected } = await render({
      name: "audit-long-music.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      audioPaths: [MUSIC12],
      patch: {
        video: { trim: { startSec: 0, endSec: 3 } },
        audio: { originalVolume: 100, tracks: [{ assetId: "a1", volume: 100 }] },
      },
    });

    expect(expected).toBeCloseTo(3, 3);
    const probe = await probeFile(out);
    expect(probe.durationSec!).toBeGreaterThan(2.8);
    expect(probe.durationSec!).toBeLessThan(3.4);
  }, 240_000);

  /**
   * The other side of the same coin, and the reason `-shortest` on its own is
   * the wrong fix: with the original muted, the only audio is a two-second
   * sting, and truncating the picture to it would throw away two thirds of the
   * video.
   */
  it("does not truncate the video to a music track that ends early", async () => {
    const { out } = await render({
      name: "audit-short-music.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      audioPaths: [MUSIC12],
      patch: {
        video: { trim: { startSec: 0, endSec: 6 } },
        audio: { muteOriginal: true, tracks: [{ assetId: "a1", volume: 100, trimEndSec: 2 }] },
      },
    });

    const probe = await probeFile(out);
    expect(probe.durationSec!).toBeGreaterThan(5.8);
    expect(probe.durationSec!).toBeLessThan(6.4);
    // The picture is what survives; the sting is still in there at the front.
    expect(await bandDb(out, 1000, { startSec: 0, durationSec: 1.5 })).toBeGreaterThan(-25);
  }, 240_000);

  /** A looped track must still be cut off by the video, as it always was. */
  it("still cuts a looped track off at the end of the video", async () => {
    const { out, args } = await render({
      name: "audit-loop.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      audioPaths: [MUSIC12],
      patch: {
        video: { trim: { startSec: 0, endSec: 4 } },
        audio: { muteOriginal: true, tracks: [{ assetId: "a1", volume: 100, loop: true }] },
      },
    });
    expect(args).toContain("-shortest");
    const probe = await probeFile(out);
    expect(probe.durationSec!).toBeLessThan(4.4);
    expect(probe.durationSec!).toBeGreaterThan(3.7);
  }, 240_000);
});

describe("audit: colour presets change the picture, not just the filter string", () => {
  /** A muted red so a saturation change is measurable in both directions. */
  let MUTED = "";

  beforeAll(async () => {
    MUTED = await gen("muted-red.mp4", [
      "-f", "lavfi", "-i", "color=c=0x996666:s=320x568:r=25:d=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
    ]);
  }, 120_000);

  it("leaves the colour alone with no preset", async () => {
    const { out } = await render({ name: "look-none.mp4", source: MUTED, facts: SHORT_FACTS });
    const { r, g, b } = await rgbMeans(out, 1.0);
    expect(r).toBeGreaterThan(130);
    expect(r - g).toBeGreaterThan(30);
    expect(Math.abs(g - b)).toBeLessThan(8);
  }, 180_000);

  it("really desaturates with the bw preset", async () => {
    const { out, graph } = await render({ name: "look-bw.mp4", source: MUTED, facts: SHORT_FACTS, patch: { look: { preset: "bw" } } });
    expect(graph).toContain("hue=s=0");
    const { r, g, b } = await rgbMeans(out, 1.0);
    // Grey means the channels have collapsed onto each other.
    expect(Math.abs(r - g)).toBeLessThan(6);
    expect(Math.abs(g - b)).toBeLessThan(6);
    // …and it is a mid grey, not a black frame that would also pass the above.
    expect(r).toBeGreaterThan(70);
    expect(r).toBeLessThan(160);
  }, 180_000);

  it("really increases saturation with the vivid preset", async () => {
    const plain = await render({ name: "look-plain.mp4", source: MUTED, facts: SHORT_FACTS });
    const vivid = await render({ name: "look-vivid.mp4", source: MUTED, facts: SHORT_FACTS, patch: { look: { preset: "vivid" } } });

    const a = await rgbMeans(plain.out, 1.0);
    const v = await rgbMeans(vivid.out, 1.0);
    expect(v.r - v.g).toBeGreaterThan(a.r - a.g + 8);
  }, 240_000);

  it("applies a manual saturation of 0 even when the preset is none", async () => {
    const { out, graph } = await render({
      name: "look-manual-desat.mp4",
      source: MUTED,
      facts: SHORT_FACTS,
      patch: { look: { saturation: 0 } },
    });
    expect(graph).toContain("eq=saturation=0.000");
    const { r, g, b } = await rgbMeans(out, 1.0);
    expect(Math.abs(r - g)).toBeLessThan(6);
    expect(Math.abs(g - b)).toBeLessThan(6);
  }, 180_000);
});

describe("audit: upload validation beyond 'this is not media'", () => {
  it("refuses a video that is longer than the configured ceiling", async () => {
    const saved = process.env.VIDEO_MAX_DURATION_SEC;
    process.env.VIDEO_MAX_DURATION_SEC = "5"; // SRC12 is 12 s
    try {
      const err = await validateUpload(SRC12, "SOURCE").then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(UnsupportedMediaError);
      expect((err as Error).message).toMatch(/minutes long/);
      // The same file is accepted once the ceiling allows it.
      process.env.VIDEO_MAX_DURATION_SEC = "3600";
      expect((await validateUpload(SRC12, "SOURCE")).durationSec!).toBeGreaterThan(11);
    } finally {
      if (saved === undefined) delete process.env.VIDEO_MAX_DURATION_SEC;
      else process.env.VIDEO_MAX_DURATION_SEC = saved;
    }
  }, 120_000);

  it("refuses a silent file uploaded into the music slot", async () => {
    await expect(validateUpload(SHORT2, "AUDIO")).rejects.toBeInstanceOf(UnsupportedMediaError);
    // …and accepts one that really carries audio.
    expect((await validateUpload(MUSIC12, "AUDIO")).audio?.codec).toBe("pcm_s16le");
  }, 120_000);

  it("refuses an audio-only file uploaded into the video slot", async () => {
    const err = await validateUpload(MUSIC12, "SOURCE").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnsupportedMediaError);
    expect((err as Error).message).toMatch(/no video track/i);
  }, 120_000);
});

describe("audit: the apostrophe fix is load-bearing, not incidental", () => {
  /**
   * The job-level test proves a subtitled render survives a scratch directory
   * named "O'Brien's temp". It cannot show WHY, and a fix nobody can see
   * working is a fix that gets refactored away. These two render at the same
   * layer, against the same directory, and differ only in whether the
   * filtergraph carries a bare filename (with `cwd`) or the absolute path the
   * product used to pass.
   */
  let awkward = "";
  let assName = "";

  beforeAll(async () => {
    awkward = join(DIR, "O'Reilly's scratch");
    await mkdir(awkward, { recursive: true });
    assName = "subs.ass";
    await writeFile(join(awkward, assName), assFor([{ start: 0.5, end: 1.5, text: "APOSTROPHE" }], "clean-white", { width: 320, height: 568 }), "utf8");
  });

  it("burns in when the graph names the file relatively and FFmpeg runs from that directory", async () => {
    const { out, graph } = await render({
      name: "apos-relative.mp4",
      source: SHORT2,
      facts: SHORT_FACTS,
      subtitlePath: assName,
      patch: { subtitles: { trackId: "t1", burnIn: true } },
      cwd: awkward,
    });
    // Nothing in the graph needed escaping, because nothing in it is a path.
    expect(graph).toContain("subtitles='subs.ass'");
    expect(graph).not.toContain("O\\'Reilly");
    expect(await ink(out, 1.0)).toBeGreaterThan(0.3);
    expect(await ink(out, 0.1)).toBeLessThan(0.02);
  }, 180_000);

  it("still cannot express that directory as an absolute path inside the graph", async () => {
    const absolute = join(awkward, assName);
    // escapeFilterPath does produce something for an apostrophe…
    expect(escapeFilterPath(absolute)).toContain("\\'");

    // …and FFmpeg still refuses it. This is the shipped bug, unfixed and
    // unfixable at the escaping layer — which is exactly why the job layer
    // changes directory instead.
    const err = await render({
      name: "apos-absolute.mp4",
      source: SHORT2,
      facts: SHORT_FACTS,
      subtitlePath: absolute,
      patch: { subtitles: { trackId: "t1", burnIn: true } },
    }).then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(FfmpegError);
    expect((err as FfmpegError).message + String((err as { stderr?: string }).stderr ?? "")).toMatch(
      /No such file or directory|Unable to open|Error initializing/i,
    );
    expect(existsSync(join(DIR, "apos-absolute.mp4"))).toBe(false);
  }, 180_000);
});

describe("audit: cancelling and misconfiguring a run", () => {
  it("kills a running encode when its signal aborts, instead of finishing it", async () => {
    const out = join(DIR, "audit-aborted.mp4");
    const controller = new AbortController();
    // A deliberately slow encode: veryslow preset over the 12 s source.
    const started = Date.now();
    const promise = ffmpeg(
      ["-hide_banner", "-nostdin", "-y", "-i", SRC12, "-c:v", "libx264", "-preset", "veryslow", "-crf", "10", "-s", "720x1280", out],
      { signal: controller.signal, timeoutMs: 300_000 },
    );
    setTimeout(() => controller.abort(), 250);

    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/cancelled/i);
    // It really stopped rather than running the encode out to completion.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 120_000);

  it("blames the working directory, not a missing FFmpeg, when the cwd is gone", async () => {
    const gone = join(DIR, "vanished-workspace");
    const err = await ffmpeg(["-hide_banner", "-nostdin", "-version"], { cwd: gone, timeoutMs: 30_000 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FfmpegMissingError);
    expect((err as Error).message).toContain(gone);
    expect((err as Error).message).toMatch(/working directory/i);
  }, 60_000);
});

describe("audit: the undici shape the Blob driver's unwrapping depends on", () => {
  /**
   * The Blob suite above stubs `fetch` and asserts that an over-long upload
   * surfaces as UploadTooLargeError. That only holds if real `fetch` hides a
   * request-body error the way the stub pretends it does. Nothing proved that,
   * and it is the single assumption the 413 rests on — so prove it against a
   * real fetch to a real (local) server.
   */
  it("hides a request-body error as TypeError('fetch failed') with the real error on .cause", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;

    try {
      const marker = new UploadTooLargeError(2048);
      let n = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          n += 1;
          if (n > 2) throw marker;
          c.enqueue(new Uint8Array(1024));
        },
      });

      const err = await fetch(`http://127.0.0.1:${port}/`, {
        method: "PUT",
        body,
        // @ts-expect-error — duplex is required for a streaming body.
        duplex: "half",
      }).then(
        () => null,
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(TypeError);
      expect((err as Error).message).toBe("fetch failed");
      // Exactly one level down, and the identical object — which is what the
      // driver's `unwrapCause` reaches for. If a Node upgrade changes this, the
      // Blob driver silently starts answering 500 instead of 413.
      expect((err as { cause?: unknown }).cause).toBe(marker);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});

describe("audit: a body that stops arriving", () => {
  /**
   * A slot is only a bound if it comes back. A half-open socket that sends a
   * header and then nothing was the case readBoundedBody's stall timer exists
   * for, and nothing exercised it.
   */
  it("gives up on a stalled body instead of holding its slot forever", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(16));
      },
      pull() {
        // never resolves: the client went quiet mid-body
        return new Promise<void>(() => {});
      },
    });

    const started = Date.now();
    const err = await readBoundedBody(body, 1024 * 1024, { stallMs: 120 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UploadStalledError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("releases the slot it took even when the read throws", async () => {
    _resetUploadSlots();
    const slot = acquireUploadSlot("stall-owner")!;
    expect(uploadsInFlight()).toBe(1);
    try {
      await readBoundedBody(
        new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new Uint8Array(4096));
          },
        }),
        1024,
      ).catch(() => {});
    } finally {
      slot.release();
    }
    expect(uploadsInFlight()).toBe(0);
  });
});

describe("audit: the assistant's answer when it proposes nothing", () => {
  const baseInput = {
    message: "make the music quieter",
    history: [] as Array<{ role: "user" | "assistant"; text: string }>,
    params: defaultEditParams(),
    context: {
      sourceLabel: "clip.mp4",
      audioAssets: [{ id: "asset-music", name: "track.mp3", durationSec: 90 }],
      subtitleInfo: "No subtitle track yet.",
      accountId: "acc1",
      projectId: "prj1",
    },
    model: "test-model",
    provider: "ANTHROPIC" as AIProviderType,
  };

  function reply(toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>, text: string | null = null) {
    chatMock.mockResolvedValueOnce({
      text,
      toolCalls: toolCalls.map((c, i) => ({ id: `tc${i}`, ...c })),
      inputTokens: 10,
      outputTokens: 5,
      stopReason: "tool_use",
      costUsd: null,
    });
  }

  beforeEach(() => chatMock.mockReset());

  /**
   * The existing suite asserts only that an invented parameter produces no
   * proposal. It does — but not because it was refused: the nested patch
   * objects were not `.strict()`, so `greenScreen` was quietly deleted and the
   * remainder was a no-op. The operator is owed a refusal, and the difference
   * is visible the moment the same proposal also carries a real change.
   */
  it("refuses an invented parameter rather than deleting it and applying the rest", async () => {
    reply([
      {
        name: "propose_edit",
        arguments: {
          patch: { video: { greenScreen: true }, audio: { originalVolume: 20 } },
          summary: "Remove the background and drop the voice to 20%.",
        },
      },
    ]);
    const turn = await runAssistantTurn(baseInput);

    // Not "applied the half it understood while promising both".
    expect(turn.proposal).toBeNull();
    expect(turn.reply).toMatch(/not in a valid form|rephrase/i);
  });

  it("refuses an invented key inside the subtitle style too", async () => {
    reply([
      { name: "propose_edit", arguments: { patch: { subtitles: { style: { karaokeBounce: true } } }, summary: "Bouncy captions." } },
    ]);
    const turn = await runAssistantTurn(baseInput);
    expect(turn.proposal).toBeNull();
    expect(turn.reply).toMatch(/not in a valid form|rephrase/i);
  });

  it("refuses an invented key inside an audio track", async () => {
    reply([
      {
        name: "propose_edit",
        arguments: { patch: { audio: { tracks: [{ assetId: "asset-music", volume: 40, reverb: 0.5 }] } }, summary: "Add reverb." },
      },
    ]);
    const turn = await runAssistantTurn(baseInput);
    expect(turn.proposal).toBeNull();
  });

  it("still accepts a well-formed patch after the schema was tightened", async () => {
    reply([
      {
        name: "propose_edit",
        arguments: {
          patch: { audio: { originalVolume: 20, tracks: [{ assetId: "asset-music", volume: 60, fadeInSec: 1, loop: true }] } },
          summary: "Quieter voice, looping music.",
        },
      },
    ]);
    const turn = await runAssistantTurn(baseInput);
    expect(turn.proposal).not.toBeNull();
    expect(turn.proposal!.next.audio.originalVolume).toBe(20);
    expect(turn.proposal!.next.audio.tracks[0]!.volume).toBe(60);
    expect(turn.proposal!.next.audio.tracks[0]!.loop).toBe(true);
  });

  /**
   * A model that answers with a tool call and no prose, whose patch turns out
   * to change nothing, left `reply` as the empty string — the operator saw a
   * blank chat bubble and no indication that anything had happened.
   */
  it("never answers with a blank message when the patch changes nothing", async () => {
    reply([{ name: "propose_edit", arguments: { patch: { audio: { originalVolume: 100 } }, summary: "Leave it." } }]);
    const turn = await runAssistantTurn(baseInput);
    expect(turn.proposal).toBeNull();
    expect(turn.reply.trim().length).toBeGreaterThan(0);
  });

  it("never answers with a blank message when it only lists what it cannot do", async () => {
    reply([{ name: "explain_unsupported", arguments: { requests: ["beat-synced cuts"], explanation: "" } }]);
    const turn = await runAssistantTurn(baseInput);
    expect(turn.unsupported).toEqual(["beat-synced cuts"]);
    expect(turn.reply.trim().length).toBeGreaterThan(0);
    expect(turn.reply).toContain("beat-synced cuts");
  });

  it("answers in the operator's language when it has nothing of its own to say", async () => {
    reply([{ name: "propose_edit", arguments: { patch: { audio: { originalVolume: 100 } }, summary: "" } }]);
    const turn = await runAssistantTurn({ ...baseInput, message: "Ovozni oʻzgartirmasdan qoldir" });
    expect(turn.language).toBe("uz");
    expect(turn.reply.trim().length).toBeGreaterThan(0);
    expect(/[a-z]/i.test(turn.reply)).toBe(true);
    expect(turn.reply).not.toMatch(/No change was needed/);
  });
});

// =====================================================================
// 12. Second audit pass — product paths the first two suites never executed
// =====================================================================

/**
 * Mean (red − blue) per horizontal half of one frame.
 *
 * The luma helper cannot see colour and `rgbMeans` averages the whole frame, so
 * neither can answer "is the LEFT word a different colour from the right one" —
 * which is the entire claim the word-highlight feature makes.
 */
async function rgbHalves(video: string, atSec: number, width: number, height: number): Promise<{ left: number; right: number }> {
  const raw = join(DIR, `frame-${frameSeq++}.rgb`);
  await ffmpeg(
    ["-hide_banner", "-nostdin", "-y", "-ss", atSec.toFixed(3), "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw],
    { timeoutMs: 60_000 },
  );
  const buf = await readFile(raw);
  expect(buf.byteLength).toBe(width * height * 3);
  const mid = Math.floor(width / 2);
  let left = 0;
  let right = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const rb = buf[i]! - buf[i + 2]!;
      if (x < mid) left += rb;
      else right += rb;
    }
  }
  await rm(raw, { force: true });
  return { left: left / (mid * height), right: right / ((width - mid) * height) };
}

describe("audit 2: speed change keeps the voice's pitch", () => {
  /**
   * "Audio is pitch-corrected to stay natural" is written into the parameter
   * schema and nothing checked it. Resampling (the naive way to change speed)
   * would move a 440 Hz tone to 880 Hz at 2x; atempo must not.
   */
  it("composes atempo within its 0.5-2.0 limit", () => {
    expect(atempoChain(1)).toEqual([]);
    expect(atempoChain(2)).toEqual(["atempo=2.000000"]);
    expect(atempoChain(4)).toEqual(["atempo=2.0", "atempo=2.000000"]);
    expect(atempoChain(3)).toEqual(["atempo=2.0", "atempo=1.500000"]);
    expect(atempoChain(0.25)).toEqual(["atempo=0.5", "atempo=0.500000"]);
    // Every chain really multiplies back to the requested speed.
    for (const speed of [0.25, 0.5, 0.75, 1.5, 2, 3, 4]) {
      const product = atempoChain(speed).reduce((acc, f) => acc * Number(f.split("=")[1]), 1);
      expect(product).toBeCloseTo(speed, 4);
    }
  });

  it("leaves a 440 Hz source at 440 Hz after a 2x render, rather than resampling it up", async () => {
    const { out, graph } = await render({
      name: "audit2-speed2.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      patch: { video: { trim: { startSec: 0, endSec: 8 }, speed: 2 } },
    });
    expect(graph).toContain("atempo=2.000000");

    const probe = await probeFile(out);
    expect(probe.durationSec!).toBeGreaterThan(3.8);
    expect(probe.durationSec!).toBeLessThan(4.4);

    const at440 = await bandDb(out, 440);
    const at880 = await bandDb(out, 880);
    expect(at440).toBeGreaterThan(-25);
    expect(at440 - at880).toBeGreaterThan(15);
  }, 240_000);
});

describe("audit 2: where an uploaded track sits and how it arrives", () => {
  it("delays the track to the second the operator placed it on the timeline", async () => {
    const { out, graph } = await render({
      name: "audit2-delay.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      audioPaths: [MUSIC12],
      patch: {
        video: { trim: { startSec: 0, endSec: 8 } },
        audio: { muteOriginal: true, tracks: [{ assetId: "a1", volume: 100, startSec: 3 }] },
      },
    });
    expect(graph).toContain("adelay=3000:all=1");

    const before = await bandDb(out, 1000, { startSec: 0.2, durationSec: 2 });
    const after = await bandDb(out, 1000, { startSec: 4, durationSec: 2 });
    expect(after).toBeGreaterThan(-25);
    expect(after - before).toBeGreaterThan(30);
  }, 240_000);

  it("really fades a track in rather than only writing afade into the graph", async () => {
    const faded = await render({
      name: "audit2-fadein.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      audioPaths: [MUSIC12],
      patch: {
        video: { trim: { startSec: 0, endSec: 6 } },
        audio: { muteOriginal: true, tracks: [{ assetId: "a1", volume: 100, fadeInSec: 3 }] },
      },
    });
    expect(faded.graph).toContain("afade=t=in:st=0.000:d=3.000");

    const plain = await render({
      name: "audit2-nofade.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      audioPaths: [MUSIC12],
      patch: {
        video: { trim: { startSec: 0, endSec: 6 } },
        audio: { muteOriginal: true, tracks: [{ assetId: "a1", volume: 100 }] },
      },
    });
    expect(plain.graph).not.toContain("afade");

    const head = { startSec: 0, durationSec: 0.4 };
    const body = { startSec: 4, durationSec: 1 };
    const fadedHead = await bandDb(faded.out, 1000, head);
    const fadedBody = await bandDb(faded.out, 1000, body);
    const plainHead = await bandDb(plain.out, 1000, head);
    const plainBody = await bandDb(plain.out, 1000, body);

    // The fade really is a ramp…
    expect(fadedBody - fadedHead).toBeGreaterThan(12);
    // …and without it the same two windows are the same level.
    expect(Math.abs(plainBody - plainHead)).toBeLessThan(2);
  }, 300_000);
});

describe("audit 2: output the player and Meta actually need", () => {
  it("writes the index ahead of the media so playback can start before the download finishes", async () => {
    const { out } = await render({
      name: "audit2-faststart.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      patch: { video: { trim: { startSec: 0, endSec: 2 } } },
      quality: "export",
    });
    const bytes = await readFile(out);
    const moov = bytes.indexOf(Buffer.from("moov", "ascii"));
    const mdat = bytes.indexOf(Buffer.from("mdat", "ascii"));
    expect(moov).toBeGreaterThan(0);
    expect(mdat).toBeGreaterThan(0);
    // Without -movflags +faststart the moov atom is written last and Meta's
    // fetcher has to download the whole file before it can start.
    expect(moov).toBeLessThan(mdat);
  }, 180_000);

  it("produces a genuinely silent file when the original is turned down to zero", async () => {
    const { out, args, graph } = await render({
      name: "audit2-silent.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      patch: { video: { trim: { startSec: 0, endSec: 2 } }, audio: { originalVolume: 0 } },
    });
    expect(graph).not.toContain("[0:a]");
    expect(args).toContain("-an");
    expect(args).not.toContain("-c:a");

    const probe = await probeFile(out);
    expect(probe.audio).toBeNull();
    expect(probe.video?.codec).toBe("h264");
  }, 180_000);

  it("caps a 16:9 target at the frame width instead of letting the height drive it", async () => {
    const wide = params({ video: { aspect: "16:9" } });
    expect(resolveTargetSize(wide, { width: 1080, height: 1920 }, "export")).toEqual({ width: 1920, height: 1080 });
    expect(resolveTargetSize(wide, { width: 1080, height: 1920 }, "preview")).toEqual({ width: 640, height: 360 });
    // maxHeight is an operator-facing ceiling, and it wins over the source.
    expect(
      resolveTargetSize(params({ video: { aspect: "9:16", maxHeight: 720 } }), { width: 1080, height: 1920 }, "export"),
    ).toEqual({ width: 406, height: 720 });

    const { out } = await render({
      name: "audit2-wide.mp4",
      source: SRC12,
      facts: SRC_FACTS,
      patch: { video: { aspect: "16:9", fit: "cover", trim: { startSec: 0, endSec: 2 } } },
    });
    const probe = await probeFile(out);
    expect(probe.displayWidth).toBe(640);
    expect(probe.displayHeight).toBe(360);
  }, 180_000);
});

describe("audit 2: per-word highlighting", () => {
  const WORDS: SubtitleCue[] = [
    { start: 0.3, end: 1.8, text: "AAA BBB", words: [{ start: 0.3, end: 1.0, text: "AAA" }, { start: 1.0, end: 1.8, text: "BBB" }] },
  ];
  const SIZE = { width: 320, height: 568 };
  /** &HAABBGGRR: #FFD400 is 00-00-D4-FF, and white is 00-FF-FF-FF. */
  const LIT = "&H0000D4FF";
  const NORMAL = "&H00FFFFFF";

  it("emits one event per word, timed to that word, with only that word recoloured", () => {
    const ass = buildAssFile(WORDS, { ...SIZE, style: applyPreset("highlighted-words") });
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events).toHaveLength(2);
    expect(events[0]!).toContain("0:00:00.30,0:00:01.00");
    expect(events[1]!).toContain("0:00:01.00,0:00:01.80");

    // The whole cue stays on screen in both; only the lit word moves.
    const litWord = (line: string) => new RegExp(`\\{\\\\c${LIT}\\}([A-Z]+)\\{\\\\c${NORMAL}\\}`).exec(line)?.[1] ?? null;
    expect(litWord(events[0]!)).toBe("AAA");
    expect(litWord(events[1]!)).toBe("BBB");
    for (const e of events) {
      expect(e).toContain("AAA");
      expect(e).toContain("BBB");
    }
  });

  it("falls back to one plain event per cue when the track has no word timings", () => {
    const ass = buildAssFile([{ start: 0.3, end: 1.8, text: "no word timings here" }], {
      ...SIZE,
      style: applyPreset("highlighted-words"),
    });
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events).toHaveLength(1);
    // The highlight colour still declares itself as the style's SecondaryColour,
    // but no event may carry an inline override: nothing is lit.
    expect(ass).toContain(`,${LIT},`);
    expect(events[0]!).not.toContain("\\c");
    expect(events[0]!).not.toContain(LIT);
    // Uppercased by the preset and wrapped for the frame width, so the cue
    // really did go through both — as one line of text, not per-word events.
    expect(events[0]!).toContain("NO WORD TIMINGS\\NHERE");
  });

  it("paints the highlight on the spoken word in the real output, and moves it", async () => {
    const litPath = join(DIR, "audit2-words.ass");
    await writeFile(litPath, buildAssFile(WORDS, { ...SIZE, style: applyPreset("highlighted-words") }), "utf8");
    const lit = await render({
      name: "audit2-words.mp4",
      source: SHORT2,
      facts: SHORT_FACTS,
      subtitlePath: litPath,
      patch: { subtitles: { trackId: "t1", burnIn: true } },
    });

    // Same cue, same preset, highlighting off: the control that proves the
    // difference below comes from the highlight and not from the glyphs.
    const flatPath = join(DIR, "audit2-words-flat.ass");
    await writeFile(
      flatPath,
      buildAssFile(WORDS, { ...SIZE, style: applyPreset("highlighted-words", { wordHighlight: false }) }),
      "utf8",
    );
    const flat = await render({
      name: "audit2-words-flat.mp4",
      source: SHORT2,
      facts: SHORT_FACTS,
      subtitlePath: flatPath,
      patch: { subtitles: { trackId: "t1", burnIn: true } },
    });

    // Both really drew text.
    expect(await ink(lit.out, 0.6)).toBeGreaterThan(0.3);
    expect(await ink(flat.out, 0.6)).toBeGreaterThan(0.3);

    const litEarly = await rgbHalves(lit.out, 0.6, 320, 568);
    const litLate = await rgbHalves(lit.out, 1.4, 320, 568);
    const flatEarly = await rgbHalves(flat.out, 0.6, 320, 568);
    const flatLate = await rgbHalves(flat.out, 1.4, 320, 568);

    // White text is colour-neutral: r − b is ~0 on both sides, at both times.
    expect(Math.abs(flatEarly.left - flatEarly.right)).toBeLessThan(0.4);
    expect(Math.abs(flatLate.left - flatLate.right)).toBeLessThan(0.4);

    // The lit word is yellow (b = 0), so its half carries the red-blue gap —
    // and the gap swaps sides exactly when the second word starts.
    expect(litEarly.left - litEarly.right).toBeGreaterThan(1);
    expect(litLate.right - litLate.left).toBeGreaterThan(1);
  }, 300_000);
});

describe("audit 2: the caption colour an operator picks is the colour on screen", () => {
  /**
   * ASS colours are &HAABBGGRR — alpha first and then BGR, REVERSED from the
   * #rrggbb the operator typed. Emitting the channels in the obvious order
   * instead renders red captions blue, and every filter-string assertion in
   * this file would still pass. Only the pixels can tell.
   */
  async function burnColor(name: string, hex: string): Promise<{ r: number; g: number; b: number }> {
    const assPath = join(DIR, `${name}.ass`);
    const style = applyPreset("clean-white", { textColor: hex, outlineWidth: 0, shadow: 0, fontSizePct: 12 });
    await writeFile(assPath, buildAssFile([{ start: 0.5, end: 1.5, text: "COLOUR" }], { width: 320, height: 568, style }), "utf8");
    const { out } = await render({
      name: `${name}.mp4`,
      source: SHORT2,
      facts: SHORT_FACTS,
      subtitlePath: assPath,
      patch: { subtitles: { trackId: "t1", burnIn: true } },
    });
    return rgbMeans(out, 1.0);
  }

  it("renders #FF0000 red and #0000FF blue, not the other way round", async () => {
    const red = await burnColor("audit2-red", "#FF0000");
    expect(red.r).toBeGreaterThan(1);
    expect(red.r).toBeGreaterThan(red.b * 5);
    expect(red.r).toBeGreaterThan(red.g * 5);

    const blue = await burnColor("audit2-blue", "#0000FF");
    expect(blue.b).toBeGreaterThan(1);
    expect(blue.b).toBeGreaterThan(blue.r * 5);
  }, 300_000);
});

describe("audit 2: caption import, export and repair", () => {
  it("round-trips a cue list through SRT, including Cyrillic", () => {
    const cues: SubtitleCue[] = [
      { start: 1.5, end: 3.25, text: "first line" },
      { start: 4, end: 5, text: "второй" },
    ];
    const srt = buildSrtFile(cues);
    expect(srt).toContain("00:00:01,500 --> 00:00:03,250");
    expect(srt.startsWith("1\n")).toBe(true);

    const back = parseSubtitleFile(srt);
    expect(back).toHaveLength(2);
    expect(back[0]!.start).toBeCloseTo(1.5, 3);
    expect(back[0]!.end).toBeCloseTo(3.25, 3);
    expect(back[0]!.text).toBe("first line");
    expect(back[1]!.text).toBe("второй");
  });

  it("reads an uploaded VTT with a BOM and dot separators", () => {
    const vtt = buildVttFile([{ start: 0.5, end: 2, text: "hello" }]);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:00.500 --> 00:00:02.000");

    const parsed = parseSubtitleFile(`﻿${vtt.replace(/\n/g, "\r\n")}`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.text).toBe("hello");
    expect(parsed[0]!.start).toBeCloseTo(0.5, 3);
  });

  it("ignores blocks that carry no timing line rather than inventing one", () => {
    const parsed = parseSubtitleFile("NOTE this is a comment\n\n1\n00:00:01,000 --> 00:00:02,000\nreal cue\n");
    expect(parsed.map((c) => c.text)).toEqual(["real cue"]);
  });

  it("repairs overlapping cues so two lines never stack on screen", () => {
    const fixed = normalizeCues([
      { start: 4, end: 9, text: "second" },
      { start: 1, end: 6, text: "first" },
      { start: 10, end: 10, text: "zero length" },
      { start: 11, end: 12, text: "   " },
      { start: -4, end: 0.5, text: " collapses   whitespace " },
    ]);
    expect(fixed.map((c) => c.text)).toEqual(["collapses whitespace", "first", "second"]);
    // Sorted, clamped at zero, whitespace collapsed, and the earlier cue
    // trimmed back to where the next one starts.
    expect(fixed[0]!.start).toBe(0);
    expect(fixed[0]!.end).toBe(0.5);
    expect(fixed[1]!.end).toBe(4);
    for (let i = 0; i < fixed.length - 1; i += 1) {
      expect(fixed[i]!.end).toBeLessThanOrEqual(fixed[i + 1]!.start);
    }
  });

  /**
   * Two cues starting at the same instant used to cost one of them its life:
   * the earlier was trimmed back to the later's start, became zero-length and
   * was dropped, text and all, with nothing said. Both must survive.
   */
  it("keeps both cues when one starts on top of another", () => {
    const fixed = normalizeCues([
      { start: 0, end: 1, text: "short" },
      { start: 0, end: 5, text: "long enough to matter" },
    ]);
    expect(fixed).toHaveLength(2);
    expect(fixed.map((c) => c.text)).toEqual(["short", "long enough to matter"]);
    // Still non-overlapping and still in order, which is the point of the repair.
    expect(fixed[0]!.end).toBeLessThanOrEqual(fixed[1]!.start);
    for (const cue of fixed) expect(cue.end).toBeGreaterThan(cue.start);
  });

  it("keeps all three when several cues share a start", () => {
    const fixed = normalizeCues([
      { start: 2, end: 3, text: "a" },
      { start: 2, end: 6, text: "b" },
      { start: 2, end: 9, text: "c" },
    ]);
    expect(fixed.map((c) => c.text).sort()).toEqual(["a", "b", "c"]);
    for (let i = 0; i < fixed.length - 1; i++) {
      expect(fixed[i]!.end).toBeLessThanOrEqual(fixed[i + 1]!.start);
    }
  });

  it("wraps a long caption onto at most two lines", () => {
    const wrapped = wrapCueText("the quick brown fox jumps over the lazy dog again and again", 24, 2);
    const lines = wrapped.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.trim().length > 0)).toBe(true);
    // No word was lost or duplicated by the rebalancing pass.
    expect(wrapped.replace(/\n/g, " ")).toBe("the quick brown fox jumps over the lazy dog again and again");
    expect(wrapCueText("short enough", 24, 2)).toBe("short enough");
  });

  it("refuses word timings that would render to a hundred megabytes of subtitle data", () => {
    const longWord = "x".repeat(99);
    const heavy: SubtitleCue[] = Array.from({ length: 300 }, (_, c) => ({
      start: c,
      end: c + 1,
      text: "heavy cue",
      words: Array.from({ length: 64 }, (_, w) => ({ start: c, end: c + 1, text: `${longWord}${w % 10}` })),
    }));
    const refused = cuesSchema.safeParse(heavy);
    expect(refused.success).toBe(false);
    expect(JSON.stringify(refused.success ? [] : refused.error.issues)).toMatch(/MB of subtitle data/);

    // A real transcript of the same cue count is untouched.
    const ordinary: SubtitleCue[] = Array.from({ length: 300 }, (_, c) => ({
      start: c,
      end: c + 1,
      text: "an ordinary spoken sentence",
      words: Array.from({ length: 12 }, (_, w) => ({ start: c, end: c + 1, text: `word${w}` })),
    }));
    expect(cuesSchema.safeParse(ordinary).success).toBe(true);
  });
});

describe("audit 2: the export warnings shown before publishing", () => {
  const base = { durationSec: 30, width: 1080, height: 1920, sizeBytes: 20 * 1024 * 1024 };

  it("says nothing about a clean vertical Reel", () => {
    expect(checkExportForInstagram({ ...base, target: "REELS" })).toEqual([]);
  });

  it("flags a Reel that is too long or too short", () => {
    expect(checkExportForInstagram({ ...base, durationSec: 1200, target: "REELS" }).map((w) => w.code)).toEqual(["REEL_TOO_LONG"]);
    const short = checkExportForInstagram({ ...base, durationSec: 2, target: "REELS" });
    expect(short.map((w) => w.code)).toEqual(["REEL_TOO_SHORT"]);
    expect(short[0]!.detail).toContain("3s minimum");
  });

  it("holds Stories to their own sixty seconds", () => {
    expect(checkExportForInstagram({ ...base, durationSec: 90, target: "STORIES" }).map((w) => w.code)).toEqual(["STORY_TOO_LONG"]);
    // The same 90 s clip is fine as a Reel.
    expect(checkExportForInstagram({ ...base, durationSec: 90, target: "REELS" })).toEqual([]);
  });

  it("flags a landscape render for a vertical surface, and leaves FEED alone", () => {
    const landscape = { durationSec: 30, width: 1920, height: 1080, sizeBytes: 1000 };
    expect(checkExportForInstagram({ ...landscape, target: "REELS" }).map((w) => w.code)).toEqual(["ASPECT_NOT_VERTICAL"]);
    expect(checkExportForInstagram({ ...landscape, target: "FEED" })).toEqual([]);
    // 4:5 is not 9:16 either, and Instagram will letterbox it.
    expect(
      checkExportForInstagram({ durationSec: 30, width: 1080, height: 1350, sizeBytes: 1000, target: "STORIES" }).map((w) => w.code),
    ).toEqual(["ASPECT_NOT_VERTICAL"]);
  });

  it("flags a file above the 1 GB upload limit whatever the surface", () => {
    const warnings = checkExportForInstagram({ ...base, sizeBytes: 2 * 1024 * 1024 * 1024, target: "FEED" });
    expect(warnings.map((w) => w.code)).toEqual(["FILE_TOO_LARGE"]);
    expect(warnings[0]!.detail).toContain("2048 MB");
  });

  it("says nothing about duration it does not know", () => {
    expect(checkExportForInstagram({ ...base, durationSec: null, target: "REELS" })).toEqual([]);
  });
});

describe("audit 2: the edit model's own guards", () => {
  it("refuses a trim whose end is not after its start", () => {
    expect(() => applyEditPatch(defaultEditParams(), { video: { trim: { startSec: 5, endSec: 5 } } })).toThrow();
    expect(() => applyEditPatch(defaultEditParams(), { video: { trim: { startSec: 5, endSec: 4 } } })).toThrow();
    expect(applyEditPatch(defaultEditParams(), { video: { trim: { startSec: 1, endSec: 2 } } }).video.trim).toEqual({
      startSec: 1,
      endSec: 2,
    });
  });

  it("refuses a volume that is not a whole percent, or out of range", () => {
    expect(editParamsSchema.safeParse({ audio: { originalVolume: 30.5 } }).success).toBe(false);
    expect(editParamsSchema.safeParse({ audio: { originalVolume: 201 } }).success).toBe(false);
    expect(editParamsSchema.safeParse({ audio: { originalVolume: 200 } }).success).toBe(true);
    expect(editParamsSchema.safeParse({ video: { speed: 5 } }).success).toBe(false);
    expect(editParamsSchema.safeParse({ video: { padColor: "black" } }).success).toBe(false);
    expect(editParamsSchema.safeParse({ audio: { tracks: Array.from({ length: 7 }, () => ({ assetId: "a" })) } }).success).toBe(false);
  });

  it("replaces the track list wholesale instead of merging it element-wise", () => {
    const withTwo = applyEditPatch(defaultEditParams(), {
      audio: { tracks: [{ assetId: "a1", volume: 40 }, { assetId: "a2", volume: 60 }] },
    });
    expect(withTwo.audio.tracks).toHaveLength(2);

    // One track in the patch means one track afterwards — not "the first is
    // updated and the second survives".
    const withOne = applyEditPatch(withTwo, { audio: { tracks: [{ assetId: "a2", volume: 10 }] } });
    expect(withOne.audio.tracks.map((t) => t.assetId)).toEqual(["a2"]);
    expect(withOne.audio.tracks[0]!.volume).toBe(10);

    // …and an audio patch that does not mention tracks leaves them alone.
    const untouched = applyEditPatch(withOne, { audio: { originalVolume: 55 } });
    expect(untouched.audio.tracks.map((t) => t.assetId)).toEqual(["a2"]);
    expect(untouched.audio.originalVolume).toBe(55);
  });

  it("lets an explicit field win over the preset it was named with", () => {
    const start = defaultEditParams().subtitles.style;
    const merged = mergeSubtitleStyle(start, { preset: "bold-social", fontSizePct: 9 });
    // The preset's whole look arrives…
    expect(merged.uppercase).toBe(true);
    expect(merged.outlineWidth).toBeCloseTo(3.5, 3);
    // …except where the patch said otherwise.
    expect(merged.fontSizePct).toBe(9);
  });

  it("does not undo a manual tweak when the same preset is named again", () => {
    const tweaked = mergeSubtitleStyle(defaultEditParams().subtitles.style, { preset: "bold-social", fontSizePct: 9 });
    const again = mergeSubtitleStyle(tweaked, { preset: "bold-social", position: "top" });
    expect(again.fontSizePct).toBe(9);
    expect(again.position).toBe("top");
  });

  it("names every changed leaf in the diff and stays silent about the rest", () => {
    const before = defaultEditParams();
    const after = applyEditPatch(before, { video: { speed: 2 }, look: { preset: "vivid" } });
    const changes = diffEditParams(before, after);
    expect(changes).toContainEqual({ path: "video.speed", from: "1", to: "2" });
    expect(changes).toContainEqual({ path: "look.preset", from: "none", to: "vivid" });
    expect(changes.map((c) => c.path).sort()).toEqual(["look.preset", "video.speed"]);
    expect(diffEditParams(before, before)).toEqual([]);
  });
});

describe("audit 2: signed asset links and storage keys", () => {
  it("accepts its own token and refuses every altered one", () => {
    const token = signAssetToken("asset-42", 60_000);
    expect(verifyAssetToken(token)).toEqual({ assetId: "asset-42" });

    const [id, exp, sig] = token.split(".") as [string, string, string];
    // A different asset id with the same signature is a different message.
    expect(verifyAssetToken(`asset-43.${exp}.${sig}`)).toBeNull();
    // A later expiry with the same signature is the obvious forgery.
    expect(verifyAssetToken(`${id}.${Number(exp) + 3_600_000}.${sig}`)).toBeNull();
    // A flipped signature character, the right length.
    expect(verifyAssetToken(`${id}.${exp}.${sig.slice(0, -1)}${sig.endsWith("a") ? "b" : "a"}`)).toBeNull();
    expect(verifyAssetToken(`${id}.${exp}`)).toBeNull();
    expect(verifyAssetToken("")).toBeNull();
    expect(verifyAssetToken(`${id}.notanumber.${sig}`)).toBeNull();
  });

  it("refuses a token that has expired", () => {
    const expired = signAssetToken("asset-42", -1_000);
    expect(expired.split(".")).toHaveLength(3);
    expect(verifyAssetToken(expired)).toBeNull();
  });

  it("builds an unguessable key per upload and keeps it inside the account's prefix", () => {
    const a = buildStorageKey("acc1", "source", "My Clip.MP4");
    const b = buildStorageKey("acc1", "source", "My Clip.MP4");
    expect(a).not.toBe(b); // never derivable from the project or asset id
    expect(a.startsWith("video/acc1/source/")).toBe(true);
    expect(a.endsWith(".mp4")).toBe(true);
    expect(() => assertSafeKey(a)).not.toThrow();

    // A hostile "scope" cannot climb out of the prefix.
    expect(buildStorageKey("acc1", "../../etc", "x.bin").startsWith("video/acc1/etc/")).toBe(true);
    expect(extensionOf("archive.tar.gz")).toBe(".gz");
    expect(extensionOf("no-extension")).toBe("");
  });

  it("refuses every key shape that could escape the root", () => {
    for (const bad of ["", "/absolute", "a/../../b", "win\\style", "with\nnewline", "with null", "x".repeat(513)]) {
      expect(() => assertSafeKey(bad)).toThrow(StorageError);
    }
  });

  it("bounds the upload limit and refuses to call a private URL publicly reachable", () => {
    const saved = process.env.VIDEO_MAX_UPLOAD_MB;
    try {
      delete process.env.VIDEO_MAX_UPLOAD_MB;
      expect(maxUploadBytes()).toBe(500 * 1024 * 1024);
      process.env.VIDEO_MAX_UPLOAD_MB = "99999";
      expect(maxUploadBytes()).toBe(2048 * 1024 * 1024); // clamped
      process.env.VIDEO_MAX_UPLOAD_MB = "-5";
      expect(maxUploadBytes()).toBe(500 * 1024 * 1024); // nonsense falls back
    } finally {
      if (saved === undefined) delete process.env.VIDEO_MAX_UPLOAD_MB;
      else process.env.VIDEO_MAX_UPLOAD_MB = saved;
    }

    expect(isPubliclyReachable("https://app.example.com/media/x.mp4")).toBe(true);
    for (const url of [
      "http://app.example.com/x.mp4",
      "https://localhost:3000/x.mp4",
      "https://127.0.0.1/x.mp4",
      "https://box.local/x.mp4",
      "https://10.0.0.5/x.mp4",
      "https://192.168.1.9/x.mp4",
      "https://172.16.4.4/x.mp4",
      "not a url",
    ]) {
      expect(isPubliclyReachable(url)).toBe(false);
    }
  });
});

describe("audit 2: why the editor says a render cannot be published", () => {
  /**
   * The first suite called this untestable because an actual Reel publish needs
   * a live Meta account. The REASON shown next to the export does not: it is
   * derived from the stored account row, and it is the only thing standing
   * between an operator and a button that fails silently.
   */
  type Account = Parameters<typeof canPublishReason>[0];
  const account = (over: Record<string, unknown>): Account =>
    ({
      id: "acc1",
      isDemo: false,
      connectionMode: "INSTAGRAM_LOGIN",
      permissions: [],
      tokens: [],
      ...over,
    }) as unknown as Account;

  const liveToken = (scopes: string[]) => ({
    kind: "user",
    status: "ACTIVE",
    expiresAt: new Date(Date.now() + 86_400_000),
    issuedAt: new Date(),
    scopes,
  });

  it("answers null when the account really can publish", () => {
    expect(canPublishReason(account({ tokens: [liveToken(["instagram_business_content_publish"])] }))).toBeNull();
  });

  it("explains a demo account instead of letting the operator click publish", () => {
    const reason = canPublishReason(account({ isDemo: true }));
    expect(reason?.code).toBe("META_UNSUPPORTED");
    expect(reason?.detail).toMatch(/Demo data/i);
    expect(reason?.fix).toMatch(/Connect a real Instagram account/i);
  });

  it("names the exact permission that is missing, per connection mode", () => {
    const igLogin = canPublishReason(account({ tokens: [liveToken(["instagram_business_manage_messages"])] }));
    expect(igLogin?.code).toBe("META_PERMISSION_MISSING");
    expect(igLogin?.fix).toMatch(/Reconnect/i);

    const fbLogin = canPublishReason(
      account({ connectionMode: "FACEBOOK_LOGIN", tokens: [{ ...liveToken(["instagram_content_publish"]), kind: "page" }] }),
    );
    expect(fbLogin).toBeNull();
  });

  it("refuses when the token has expired even though the scope was once granted", () => {
    const reason = canPublishReason(
      account({ tokens: [{ ...liveToken(["instagram_business_content_publish"]), expiresAt: new Date(Date.now() - 1000) }] }),
    );
    expect(reason).not.toBeNull();
    expect(reason?.code).toBe("META_PERMISSION_MISSING");
  });

  it("honours an explicitly revoked permission over a stale token's scope list", () => {
    const reason = canPublishReason(
      account({
        tokens: [liveToken(["instagram_business_content_publish"])],
        permissions: [{ permission: "instagram_business_content_publish", granted: false }],
      }),
    );
    expect(reason).not.toBeNull();
  });
});

describe("audit 2: queueing, cancelling and reconciling video jobs", () => {
  const enqueueMock = vi.mocked(enqueue);
  const jobRow = (id: string) => store.videoJob.find((j) => j.id === id)!;

  function seedJobRow(row: Record<string, unknown>): Record<string, unknown> {
    const full: Record<string, unknown> = {
      accountId: "acc1",
      status: "QUEUED",
      progressPct: 0,
      error: null,
      queueJobId: null,
      startedAt: null,
      finishedAt: null,
      cancelledAt: null,
      params: {},
      createdAt: new Date(),
      updatedAt: new Date(),
      ...row,
    };
    store.videoJob.push(full);
    return full;
  }

  beforeEach(() => enqueueMock.mockClear());

  it("queues a job and records the queue entry that will run it", async () => {
    enqueueMock.mockResolvedValueOnce({ id: "q-happy" } as never);
    const job = await enqueueVideoJob({ accountId: "acc1", projectId: "prj-enq", kind: "EXPORT" as VideoJobKind, params: { a: 1 } });

    expect(job.status).toBe("QUEUED");
    expect(job.queueJobId).toBe("q-happy");
    expect(store.videoJob.filter((j) => j.projectId === "prj-enq")).toHaveLength(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("hands back the job that already owns an idempotency key instead of making a twin", async () => {
    store.job.push({ id: "q-dup", idempotencyKey: "video:dup", payload: { videoJobId: "vj-dup-owner" } });
    seedJobRow({ id: "vj-dup-owner", projectId: "prj-dup", kind: "EXPORT" });

    const before = store.videoJob.length;
    const job = await enqueueVideoJob({
      accountId: "acc1",
      projectId: "prj-dup",
      kind: "EXPORT" as VideoJobKind,
      params: {},
      idempotencyKey: "video:dup",
    });

    expect(job.id).toBe("vj-dup-owner");
    expect(store.videoJob.length).toBe(before);
    // It never even reached the queue: a duplicate must cost nothing.
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it("drops its own row when it loses the race for the key, and returns the winner", async () => {
    enqueueMock.mockImplementationOnce(async () => {
      // The winner's queue entry appears while this call is in flight.
      store.job.push({ id: "q-race", idempotencyKey: "video:race", payload: { videoJobId: "vj-race-winner" } });
      seedJobRow({ id: "vj-race-winner", projectId: "prj-race", kind: "PREVIEW" });
      return null;
    });

    const job = await enqueueVideoJob({
      accountId: "acc1",
      projectId: "prj-race",
      kind: "PREVIEW" as VideoJobKind,
      params: {},
      idempotencyKey: "video:race",
    });

    expect(job.id).toBe("vj-race-winner");
    // Exactly one row for this project: the loser deleted itself.
    expect(store.videoJob.filter((j) => j.projectId === "prj-race")).toHaveLength(1);
  });

  it("fails loudly rather than leaving a row queued forever behind an orphaned key", async () => {
    const job = await enqueueVideoJob({
      accountId: "acc1",
      projectId: "prj-orphan",
      kind: "EXPORT" as VideoJobKind,
      params: {},
      idempotencyKey: "video:orphan",
    });

    expect(job.status).toBe("FAILED");
    expect(String(job.error)).toMatch(/already queued under the same key/i);
    expect(job.finishedAt).toBeInstanceOf(Date);
  });

  it("cancels a job that is still queued or running, and nothing else", async () => {
    seedJobRow({ id: "vj-c-queued", projectId: "prj-c", kind: "EXPORT" });
    seedJobRow({ id: "vj-c-running", projectId: "prj-c", kind: "EXPORT", status: "RUNNING" });
    seedJobRow({ id: "vj-c-done", projectId: "prj-c", kind: "EXPORT", status: "DONE" });

    expect(await cancelVideoJob("vj-c-queued")).toBe(true);
    expect(jobRow("vj-c-queued").status).toBe("CANCELLED");
    expect(jobRow("vj-c-queued").cancelledAt).toBeInstanceOf(Date);

    expect(await cancelVideoJob("vj-c-running")).toBe(true);
    // Already cancelled, and a finished job: neither may be cancelled again.
    expect(await cancelVideoJob("vj-c-queued")).toBe(false);
    expect(await cancelVideoJob("vj-c-done")).toBe(false);
    expect(jobRow("vj-c-done").status).toBe("DONE");
    expect(await cancelVideoJob("vj-does-not-exist")).toBe(false);
  });

  it("does not start work for a job that was cancelled before it was picked up", async () => {
    seedJobRow({ id: "vj-precancelled", projectId: "prj-none", kind: "EXPORT", status: "CANCELLED" });
    await runVideoJob("vj-precancelled");
    expect(jobRow("vj-precancelled").status).toBe("CANCELLED");
    expect(jobRow("vj-precancelled").startedAt).toBeNull();

    // A job row that vanished must not throw either — the queue would retry it.
    await expect(runVideoJob("vj-never-existed")).resolves.toBeUndefined();
  });

  it("reports an unimplemented job kind as a failure an operator can read", async () => {
    seedJobRow({ id: "vj-wave", projectId: "prj-none", kind: "WAVEFORM" });
    await expect(runVideoJob("vj-wave")).rejects.toThrow(/not implemented/i);
    expect(jobRow("vj-wave").status).toBe("FAILED");
    expect(String(jobRow("vj-wave").error)).toMatch(/Waveform extraction is not implemented/);
  });

  it("fails the jobs whose runner is gone and leaves the live ones alone", async () => {
    const old = new Date(Date.now() - 60 * 60_000);
    seedJobRow({ id: "vj-abandoned", projectId: "prj-s", kind: "EXPORT", status: "RUNNING", queueJobId: "q-dead", updatedAt: old });
    seedJobRow({ id: "vj-unqueued", projectId: "prj-s", kind: "EXPORT", status: "QUEUED", queueJobId: null, updatedAt: old });
    seedJobRow({ id: "vj-working", projectId: "prj-s", kind: "EXPORT", status: "RUNNING", queueJobId: "q-live", updatedAt: old });
    seedJobRow({ id: "vj-retrying", projectId: "prj-s", kind: "EXPORT", status: "QUEUED", queueJobId: "q-retry", updatedAt: old });

    store.job.push({ id: "q-dead", status: "RUNNING", attempts: 3, maxAttempts: 3, lockedAt: old, leaseExpiresAt: old });
    store.job.push({ id: "q-live", status: "RUNNING", attempts: 1, maxAttempts: 3, lockedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 300_000) });
    store.job.push({ id: "q-retry", status: "FAILED", attempts: 1, maxAttempts: 3, lockedAt: null, leaseExpiresAt: null });

    const failed = await reconcileStalledVideoJobs();
    expect(failed).toBe(2);

    expect(jobRow("vj-abandoned").status).toBe("FAILED");
    expect(String(jobRow("vj-abandoned").error)).toMatch(/worker stopped/i);
    expect(jobRow("vj-unqueued").status).toBe("FAILED");
    expect(String(jobRow("vj-unqueued").error)).toMatch(/Nothing is left in the queue/i);

    // A lease still held and a retry the queue will take back are both alive.
    expect(jobRow("vj-working").status).toBe("RUNNING");
    expect(jobRow("vj-retrying").status).toBe("QUEUED");

    // A second sweep finds nothing left to do.
    expect(await reconcileStalledVideoJobs()).toBe(0);
  });
});

describe("audit 2: the job kinds the first suite never ran", () => {
  async function seedProjectFor(
    prefix: string,
    sourceFile: string,
    facts: { durationSec: number | null; width: number | null; height: number | null; hasAudio: boolean },
  ) {
    const key = `video/acc1/source/${prefix}.mp4`;
    const full = join(STORE_ROOT, key);
    await mkdir(dirname(full), { recursive: true });
    await copyFile(sourceFile, full);
    store.videoAsset.push({
      id: `src-${prefix}`,
      accountId: "acc1",
      projectId: `prj-${prefix}`,
      role: "SOURCE",
      status: "READY",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: (await stat(full)).size,
      driver: "local",
      storageKey: key,
      ...facts,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    store.videoProject.push({
      id: `prj-${prefix}`,
      accountId: "acc1",
      title: "QA clip",
      status: "DRAFT",
      sourceAssetId: `src-${prefix}`,
      params: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  function pushJob(id: string, kind: string, projectId: string, params: Record<string, unknown>): Record<string, unknown> {
    const row: Record<string, unknown> = {
      id,
      accountId: "acc1",
      projectId,
      kind,
      status: "QUEUED",
      params,
      progressPct: 0,
      error: null,
      queueJobId: null,
      startedAt: null,
      finishedAt: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store.videoJob.push(row);
    return row;
  }

  it("extracts a cover frame as its own job and records the asset it produced", async () => {
    await seedProjectFor("thumbjob", SRC12, { durationSec: 12, width: 360, height: 640, hasAudio: true });
    const job = pushJob("vj-thumbjob", "THUMBNAIL", "prj-thumbjob", { atSec: 3 });

    await runVideoJob("vj-thumbjob");

    expect(job.status).toBe("DONE");
    expect(job.error).toBeNull();
    const thumbs = store.videoAsset.filter((a) => a.projectId === "prj-thumbjob" && a.role === "THUMBNAIL");
    expect(thumbs).toHaveLength(1);
    expect(job.outputAssetId).toBe(thumbs[0]!.id);
    expect(thumbs[0]!.mimeType).toBe("image/jpeg");

    // The bytes really are a 720-wide JPEG on disk.
    const stored = join(STORE_ROOT, String(thumbs[0]!.storageKey));
    expect(existsSync(stored)).toBe(true);
    const probe = await probeFile(stored);
    expect(probe.video?.width).toBe(720);
    expect(probe.video?.height).toBe(1280);
    expect(Number(thumbs[0]!.sizeBytes)).toBeGreaterThan(500);
  }, 240_000);

  it("marks the asset itself FAILED when a probe job finds the upload is not media", async () => {
    const key = "video/acc1/source/junk-probe.mp4";
    const full = join(STORE_ROOT, key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, Buffer.from("PK this is a zip pretending to be an mp4"));
    store.videoAsset.push({
      id: "src-junkprobe",
      accountId: "acc1",
      projectId: "prj-junkprobe",
      role: "SOURCE",
      status: "UPLOADING",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 42,
      driver: "local",
      storageKey: key,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const job = pushJob("vj-junkprobe", "PROBE", "prj-junkprobe", { assetId: "src-junkprobe", role: "SOURCE" });

    await expect(runVideoJob("vj-junkprobe")).rejects.toBeInstanceOf(UnsupportedMediaError);

    const asset = store.videoAsset.find((a) => a.id === "src-junkprobe")!;
    expect(asset.status).toBe("FAILED");
    expect(String(asset.error)).toMatch(/could not be read as media/i);
    expect(job.status).toBe("FAILED");
  }, 180_000);

  it("promotes a probed upload to READY with the facts ffprobe reported", async () => {
    const key = "video/acc1/source/good-probe.mp4";
    const full = join(STORE_ROOT, key);
    await mkdir(dirname(full), { recursive: true });
    await copyFile(SRC12, full);
    store.videoAsset.push({
      id: "src-goodprobe",
      accountId: "acc1",
      projectId: "prj-goodprobe",
      role: "SOURCE",
      status: "UPLOADING",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: (await stat(full)).size,
      driver: "local",
      storageKey: key,
      durationSec: null,
      width: null,
      height: null,
      hasAudio: false,
      error: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    pushJob("vj-goodprobe", "PROBE", "prj-goodprobe", { assetId: "src-goodprobe", role: "SOURCE" });

    await runVideoJob("vj-goodprobe");

    const asset = store.videoAsset.find((a) => a.id === "src-goodprobe")!;
    expect(asset.status).toBe("READY");
    expect(asset.width).toBe(360);
    expect(asset.height).toBe(640);
    expect(asset.hasAudio).toBe(true);
    expect(Number(asset.durationSec)).toBeGreaterThan(11.8);
  }, 180_000);

  it("refuses to transcribe a video with no audio, before spending anything on a provider", async () => {
    await seedProjectFor("silentstt", SHORT2, { durationSec: 2, width: 320, height: 568, hasAudio: false });
    const job = pushJob("vj-silentstt", "TRANSCRIBE", "prj-silentstt", {});

    await expect(runVideoJob("vj-silentstt")).rejects.toThrow(/no audio track to transcribe/i);
    expect(job.status).toBe("FAILED");
    expect(store.subtitleTrack.filter((t) => t.projectId === "prj-silentstt")).toHaveLength(0);
  }, 120_000);
});

// =====================================================================
// 13. Second audit pass, part two — controls that had never been measured
// =====================================================================

/** Vertical centre of gravity of the ink in one frame, in pixels from the top. */
async function inkCentroidY(video: string, atSec: number, width: number, height: number): Promise<number> {
  const raw = join(DIR, `frame-${frameSeq++}.gray`);
  await ffmpeg(
    ["-hide_banner", "-nostdin", "-y", "-ss", atSec.toFixed(3), "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", raw],
    { timeoutMs: 60_000 },
  );
  const buf = await readFile(raw);
  expect(buf.byteLength).toBe(width * height);
  let mass = 0;
  let weighted = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const v = buf[y * width + x]!;
      if (v < 40) continue; // ignore the black background and its fringe
      mass += v;
      weighted += v * y;
    }
  }
  await rm(raw, { force: true });
  expect(mass).toBeGreaterThan(0);
  return weighted / mass;
}

/** Mean RGB of a small box, so one sampled point survives compression. */
async function rgbBox(
  video: string,
  atSec: number,
  width: number,
  height: number,
  cx: number,
  cy: number,
  half = 4,
): Promise<{ r: number; g: number; b: number }> {
  const raw = join(DIR, `frame-${frameSeq++}.rgb`);
  await ffmpeg(
    ["-hide_banner", "-nostdin", "-y", "-ss", atSec.toFixed(3), "-i", video, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", raw],
    { timeoutMs: 60_000 },
  );
  const buf = await readFile(raw);
  expect(buf.byteLength).toBe(width * height * 3);
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = cy - half; y <= cy + half; y += 1) {
    for (let x = cx - half; x <= cx + half; x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = (y * width + x) * 3;
      r += buf[i]!;
      g += buf[i + 1]!;
      b += buf[i + 2]!;
      n += 1;
    }
  }
  await rm(raw, { force: true });
  expect(n).toBeGreaterThan(0);
  return { r: r / n, g: g / n, b: b / n };
}

describe("audit 2: the caption position control", () => {
  const styleLineFor = (position: "top" | "middle" | "lower-center" | "bottom") =>
    buildAssFile([{ start: 0.5, end: 1.5, text: "POSITION" }], {
      width: 320,
      height: 568,
      style: applyPreset("clean-white", { position }),
    })
      .split("\n")
      .find((l) => l.startsWith("Style: Default,"))!;

  /**
   * The model offers four positions. ASS bottom-aligns both "lower-center" and
   * "bottom", so unless their margins differ the two produce the IDENTICAL
   * style line — a control with four options and three outcomes, where an
   * operator who picks "bottom" sees nothing change.
   */
  it("gives all four positions a distinct style, not three", () => {
    const lines = (["top", "middle", "lower-center", "bottom"] as const).map(styleLineFor);
    expect(new Set(lines).size).toBe(4);
    // Alignment (field 18) is 8 / 5 / 2 / 2 — the bottom pair can only be told
    // apart by MarginV (field 21).
    const field = (line: string, i: number) => line.split(",")[i]!;
    expect(field(lines[0]!, 18)).toBe("8");
    expect(field(lines[1]!, 18)).toBe("5");
    expect(field(lines[2]!, 18)).toBe("2");
    expect(field(lines[3]!, 18)).toBe("2");
    expect(Number(field(lines[3]!, 21))).toBeLessThan(Number(field(lines[2]!, 21)));
  });

  it("puts the caption where the operator asked, measured on the real frame", async () => {
    async function centroid(name: string, position: "top" | "middle" | "lower-center" | "bottom"): Promise<number> {
      const assPath = join(DIR, `pos-${name}.ass`);
      await writeFile(
        assPath,
        buildAssFile([{ start: 0.5, end: 1.5, text: "POSITION" }], {
          width: 320,
          height: 568,
          style: applyPreset("clean-white", { position }),
        }),
        "utf8",
      );
      const { out } = await render({
        name: `pos-${name}.mp4`,
        source: SHORT2,
        facts: SHORT_FACTS,
        subtitlePath: assPath,
        patch: { subtitles: { trackId: "t1", burnIn: true } },
      });
      return inkCentroidY(out, 1.0, 320, 568);
    }

    const top = await centroid("top", "top");
    const middle = await centroid("middle", "middle");
    const lower = await centroid("lower", "lower-center");
    const bottom = await centroid("bottom", "bottom");

    expect(top).toBeLessThan(568 * 0.35);
    expect(middle).toBeGreaterThan(568 * 0.4);
    expect(middle).toBeLessThan(568 * 0.6);
    expect(lower).toBeGreaterThan(568 * 0.7);
    // …and "bottom" really is nearer the edge than "lower-center".
    expect(bottom).toBeGreaterThan(lower + 20);
    expect(bottom).toBeLessThan(568);
  }, 300_000);
});

describe("audit 2: fit and pad colour, measured on the padded pixels", () => {
  /** A white clip, so a pad colour is unmistakable against the picture. */
  let WHITE2 = "";

  beforeAll(async () => {
    WHITE2 = await gen("white2.mp4", [
      "-f", "lavfi", "-i", "color=c=white:s=320x568:r=25:d=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast",
    ]);
  }, 120_000);

  it("fills the bars with the colour the operator chose, in the right place", async () => {
    const { out, graph } = await render({
      name: "audit2-pad-red.mp4",
      source: WHITE2,
      facts: SHORT_FACTS,
      patch: { video: { aspect: "1:1", fit: "contain", padColor: "#FF0000" } },
    });
    // 320x568 fitted into a 568x568 square leaves 124 px of bar each side.
    expect(graph).toContain("pad=568:568");
    expect(graph).toContain(":0xFF0000");
    const probe = await probeFile(out);
    expect(probe.displayWidth).toBe(568);
    expect(probe.displayHeight).toBe(568);

    const bar = await rgbBox(out, 1.0, 568, 568, 20, 284);
    const picture = await rgbBox(out, 1.0, 568, 568, 284, 284);
    // The bar is red…
    expect(bar.r).toBeGreaterThan(150);
    expect(bar.g).toBeLessThan(80);
    expect(bar.b).toBeLessThan(80);
    // …and the picture inside it is the untouched white source.
    expect(picture.r).toBeGreaterThan(200);
    expect(picture.g).toBeGreaterThan(200);
    expect(picture.b).toBeGreaterThan(200);
  }, 240_000);

  it("shows no bar at all in cover mode: it crops instead", async () => {
    const { out, graph } = await render({
      name: "audit2-cover.mp4",
      source: WHITE2,
      facts: SHORT_FACTS,
      patch: { video: { aspect: "1:1", fit: "cover", padColor: "#FF0000" } },
    });
    expect(graph).toContain("crop=568:568");
    expect(graph).not.toContain("pad=");

    // Every corner is the source, not the pad colour.
    for (const [x, y] of [
      [20, 20],
      [548, 20],
      [20, 548],
      [548, 548],
    ] as Array<[number, number]>) {
      const px = await rgbBox(out, 1.0, 568, 568, x, y);
      expect(px.r).toBeGreaterThan(200);
      expect(px.g).toBeGreaterThan(200);
      expect(px.b).toBeGreaterThan(200);
    }
  }, 240_000);
});

describe("audit 2: word highlighting when the line has to wrap", () => {
  const LONG: SubtitleCue[] = [
    {
      start: 0.2,
      end: 2.0,
      text: "one two three four five six",
      words: ["one", "two", "three", "four", "five", "six"].map((text, i) => ({
        start: 0.2 + i * 0.3,
        end: 0.5 + i * 0.3,
        text,
      })),
    },
  ];

  it("keeps every word, lights exactly one, and breaks the line where the plain text breaks", () => {
    const ass = buildAssFile(LONG, { width: 320, height: 568, style: applyPreset("highlighted-words") });
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(events).toHaveLength(6);

    for (const [i, event] of events.entries()) {
      const body = event.split(",").slice(9).join(",");
      // Exactly one word is lit, and it is the i-th.
      const lit = [...body.matchAll(/\{\\c&H0000D4FF\}([A-Z]+)\{\\c&H00FFFFFF\}/g)].map((m) => m[1]);
      expect(lit).toEqual([["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX"][i]]);
      // Nothing was dropped by the break-insertion pass.
      const plain = body.replace(/\{[^}]*\}/g, "").replace(/\\N/g, " ").split(/\s+/).filter(Boolean);
      expect(plain).toEqual(["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX"]);
      // It really did wrap…
      expect(body).toContain("\\N");
      // …and it does not end on a break, which would render an empty line
      // under the caption and lift it off the margin the operator set.
      expect(body.endsWith("\\N")).toBe(false);
    }
  });
});

describe("audit 2: the Uzbek modifier letter is a mark, not a box", () => {
  async function burnAt(name: string, text: string): Promise<number> {
    const assPath = join(DIR, `${name}.ass`);
    await writeFile(
      assPath,
      buildAssFile([{ start: 0.5, end: 1.5, text }], { width: 320, height: 568, style: applyPreset("clean-white") }),
      "utf8",
    );
    const { out } = await render({
      name: `${name}.mp4`,
      source: SHORT2,
      facts: SHORT_FACTS,
      subtitlePath: assPath,
      patch: { subtitles: { trackId: "t1", burnIn: true } },
    });
    return ink(out, 1.0);
  }

  /**
   * "The marked string carries more ink than the bare one" only proves SOMETHING
   * was drawn — a .notdef box would pass it too. A missing glyph is a full-size
   * rectangle, so six of them would come within touching distance of the widest
   * real letter. Six real ʻ are commas: a fraction of the ink.
   */
  it("draws six modifier letters as far less ink than six wide Cyrillic letters", async () => {
    const marks = await burnAt("uz-marks6", "ʻʻʻʻʻʻ");
    const wide = await burnAt("uz-wide6", "ЖЖЖЖЖЖ");
    expect(marks).toBeGreaterThan(0.01);
    expect(wide).toBeGreaterThan(0.3);
    expect(wide / marks).toBeGreaterThan(4);
  }, 240_000);
});

// =====================================================================
// 14. Speech-to-text — the parts that do NOT need a paid provider
// =====================================================================

/**
 * The first suite wrote transcription off as untestable because proving
 * transcription QUALITY needs a live provider. That is true of the words. It is
 * not true of everything the operator actually hits: whether the feature says
 * it is configured, what it does when it is not, how a provider's answer is
 * turned into cues and word timings, and which failures are reported as the
 * provider's fault rather than the operator's. Those are this module's own
 * logic, and a canned provider response exercises all of it.
 */
describe("speech-to-text without a provider account", () => {
  const ENV_KEYS = ["OPENAI_API_KEY", "GOOGLE_AI_API_KEY", "AI_API_KEY", "AI_PROVIDER", "STT_PROVIDER", "STT_MODEL", "OPENAI_BASE_URL"] as const;
  let saved: Record<string, string | undefined> = {};
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    globalThis.fetch = realFetch;
  });

  it("reports itself unavailable, with the fix, when nothing is configured", () => {
    const status = sttStatus();
    expect(status.available).toBe(false);
    expect(status.provider).toBeNull();
    expect(status.reason).toMatch(/no speech-to-text provider/i);
    expect(status.fix).toMatch(/AI_API_KEY|GOOGLE_AI_API_KEY/);
  });

  it("picks the provider the keys and STT_PROVIDER actually allow", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    expect(sttStatus()).toMatchObject({ available: true, provider: "openai-compatible", model: "whisper-1" });

    // Word timings are why the OpenAI-compatible route is preferred, so it wins
    // over Google when both are configured.
    process.env.GOOGLE_AI_API_KEY = "g-test";
    expect(sttStatus().provider).toBe("openai-compatible");

    process.env.STT_PROVIDER = "google";
    expect(sttStatus()).toMatchObject({ provider: "google", model: "gemini-2.5-flash" });

    // Pinning a provider whose key is absent must report unavailable rather
    // than silently using the other one.
    delete process.env.GOOGLE_AI_API_KEY;
    expect(sttStatus().available).toBe(false);

    process.env.STT_PROVIDER = "none";
    process.env.GOOGLE_AI_API_KEY = "g-test";
    expect(sttStatus().available).toBe(false);

    delete process.env.STT_PROVIDER;
    process.env.STT_MODEL = "whisper-large-v3";
    expect(sttModel("openai-compatible")).toBe("whisper-large-v3");
  });

  it("refuses to transcribe with nothing configured, and says what to set", async () => {
    const err = await transcribeAudio(MUSIC12).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SttUnavailableError);
    expect((err as SttUnavailableError).fix).toMatch(/AI_API_KEY|GOOGLE_AI_API_KEY/);
  });

  it("turns a provider's verbose_json into cues with the right words on each one", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    let sentTo = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      sentTo = String(url);
      return new Response(
        JSON.stringify({
          language: "uz",
          text: "salom dunyo yana bir",
          segments: [
            { start: 0, end: 1.2, text: " salom dunyo " },
            { start: 1.2, end: 2.4, text: " yana bir " },
          ],
          words: [
            { start: 0, end: 0.5, word: "salom" },
            { start: 0.6, end: 1.2, word: "dunyo" },
            { start: 1.3, end: 1.8, word: "yana" },
            { start: 1.9, end: 2.4, word: "bir" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await transcribeAudio(MUSIC12, { languageHint: "uz" });

    expect(sentTo).toContain("/audio/transcriptions");
    expect(result.provider).toBe("openai-compatible");
    expect(result.language).toBe("uz");
    expect(result.hasWordTimings).toBe(true);
    expect(result.cues).toHaveLength(2);
    // Text is trimmed, and each word lands on the cue whose window contains it.
    expect(result.cues[0]!.text).toBe("salom dunyo");
    expect(result.cues[0]!.words!.map((w) => w.text)).toEqual(["salom", "dunyo"]);
    expect(result.cues[1]!.words!.map((w) => w.text)).toEqual(["yana", "bir"]);
    // And the result is renderable: it survives the same normalisation the
    // transcribe job puts it through before storing it.
    expect(normalizeCues(result.cues)).toHaveLength(2);
  });

  it("blames the provider, not the operator's file, for each way the call can fail", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const failWith = (status: number, body = "nope") => {
      globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
      return transcribeAudio(MUSIC12).then(
        () => null,
        (e: unknown) => e as SttUnavailableError,
      );
    };

    const noBalance = await failWith(402);
    expect(noBalance).toBeInstanceOf(SttUnavailableError);
    expect(noBalance!.message).toMatch(/no balance/i);
    expect(noBalance!.fix).toMatch(/Top up|STT_PROVIDER=google/);

    expect((await failWith(401))!.message).toMatch(/rejected the API key/i);
    expect((await failWith(404))!.message).toMatch(/does not offer the model/i);
    expect((await failWith(500))!.message).toMatch(/Transcription failed \(500\)/);
  });

  /**
   * Some OpenAI-compatible gateways answer verbose_json with the flat text and
   * no segments at all. The module says it makes "a single cue rather than
   * nothing" — but a cue from 0 to 0 is zero-length, and normalizeCues (which
   * the transcribe job runs before storing) drops it. The operator got an empty
   * subtitle track, a green job, and no captions.
   */
  it("gives a segment-less answer a real duration instead of a cue that gets dropped", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ language: "en", text: "the whole clip as one line" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    // MUSIC12 is a real 12 s, 48 kHz, mono, 16-bit WAV on disk.
    const result = await transcribeAudio(MUSIC12);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]!.text).toBe("the whole clip as one line");
    expect(result.cues[0]!.end).toBeGreaterThan(11.9);
    expect(result.cues[0]!.end).toBeLessThan(12.1);
    // The cue the job would actually store survives normalisation.
    expect(normalizeCues(result.cues)).toHaveLength(1);
  });

  it("refuses a segment-less answer it cannot time, rather than storing an empty track", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ text: "untimeable" }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    // SRC12 is an mp4, not a WAV: nothing here can say how long the cue is.
    const err = await transcribeAudio(SRC12).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SttUnavailableError);
    expect((err as Error).message).toMatch(/no timings/i);
    expect((err as SttUnavailableError).fix).toMatch(/STT_MODEL|STT_PROVIDER/);
  }, 60_000);

  it("falls back to Google when the primary provider is unusable", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.GOOGLE_AI_API_KEY = "g-test";
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const href = String(url);
      calls.push(href);
      if (href.includes("/audio/transcriptions")) return new Response("unauthorized", { status: 401 });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '```json\n[{"start":0,"end":1.5,"text":"salom"}]\n```' }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await transcribeAudio(MUSIC12);
    expect(calls.some((c) => c.includes("/audio/transcriptions"))).toBe(true);
    expect(calls.some((c) => c.includes("generativelanguage.googleapis.com"))).toBe(true);
    expect(result.provider).toBe("google");
    expect(result.cues).toEqual([{ start: 0, end: 1.5, text: "salom" }]);
    // Gemini gives no word timings, so word highlighting must not be offered.
    expect(result.hasWordTimings).toBe(false);
  }, 60_000);

  it("reads a model's JSON out of a code fence or surrounding prose", () => {
    expect(parseCueJson('```json\n[{"start":0,"end":1,"text":"hi"}]\n```')).toEqual([{ start: 0, end: 1, text: "hi" }]);
    expect(parseCueJson('Sure! Here it is: [{"start":1,"end":2,"text":"ok"}] — hope that helps')).toEqual([
      { start: 1, end: 2, text: "ok" },
    ]);
    // Entries that cannot be placed on a timeline are dropped, not guessed at.
    expect(parseCueJson('[{"start":"x","end":2,"text":"bad"},{"start":0,"end":1,"text":"  "},{"start":0,"end":1,"text":" keep "}]')).toEqual([
      { start: 0, end: 1, text: "keep" },
    ]);
    expect(parseCueJson("I could not hear any speech.")).toEqual([]);
    expect(parseCueJson("[not json at all")).toEqual([]);
    expect(parseCueJson("[]")).toEqual([]);
  });

  it("tells the operator what to configure when they ask for subtitles with no provider", async () => {
    const key = "video/acc1/source/sttjob.mp4";
    const full = join(STORE_ROOT, key);
    await mkdir(dirname(full), { recursive: true });
    await copyFile(SRC12, full);
    store.videoAsset.push({
      id: "src-sttjob",
      accountId: "acc1",
      projectId: "prj-sttjob",
      role: "SOURCE",
      status: "READY",
      filename: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: (await stat(full)).size,
      driver: "local",
      storageKey: key,
      durationSec: 12,
      width: 360,
      height: 640,
      hasAudio: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    store.videoProject.push({
      id: "prj-sttjob",
      accountId: "acc1",
      title: "QA clip",
      status: "DRAFT",
      sourceAssetId: "src-sttjob",
      params: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const job: Record<string, unknown> = {
      id: "vj-sttjob",
      accountId: "acc1",
      projectId: "prj-sttjob",
      kind: "TRANSCRIBE",
      status: "QUEUED",
      params: {},
      progressPct: 0,
      error: null,
      queueJobId: null,
      startedAt: null,
      finishedAt: null,
      cancelledAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    store.videoJob.push(job);

    await expect(runVideoJob("vj-sttjob")).rejects.toBeInstanceOf(SttUnavailableError);

    expect(job.status).toBe("FAILED");
    // The stored error carries BOTH the reason and the fix, because that is all
    // the operator will ever see.
    expect(String(job.error)).toMatch(/no speech-to-text provider/i);
    expect(String(job.error)).toMatch(/AI_API_KEY/);
    expect(store.subtitleTrack.filter((t) => t.projectId === "prj-sttjob")).toHaveLength(0);
  }, 180_000);
});

// =====================================================================
// 15. The capability panel — what the editor tells an operator is working
// =====================================================================

/**
 * This panel is the product's answer to "why is nothing happening". Every other
 * suite here runs with a worker, storage and FFmpeg present; nothing checked
 * what the editor SAYS when they are not, and a panel that reports a feature as
 * ready when it cannot run is worse than no panel.
 */
describe("video capabilities reporting", () => {
  const ENV_KEYS = ["GOOGLE_AI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_API_KEY", "AI_PROVIDER", "STT_PROVIDER", "VERCEL"] as const;
  let saved: Record<string, string | undefined> = {};
  const workerOnline = vi.mocked(isVideoWorkerOnline);

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    workerOnline.mockResolvedValue(true);
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    workerOnline.mockResolvedValue(true);
  });

  it("refuses to call rendering available when no worker has reported in", async () => {
    workerOnline.mockResolvedValue(false);
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.GOOGLE_AI_API_KEY = "g-test";

    const caps = await videoCapabilities();

    expect(caps.rendering.available).toBe(false);
    expect(caps.worker.available).toBe(false);
    expect(caps.rendering.reason).toMatch(/reported in/i);
    expect(caps.rendering.fix).toMatch(/npm run worker/);

    // Work that runs as a video job is unavailable too, however well configured
    // it is: the provider key is not what executes it.
    expect(caps.subtitlesAuto.available).toBe(false);
    expect(caps.subtitlesAuto.fix).toMatch(/npm run worker/);
    expect(caps.sampleAnalysis.available).toBe(false);

    // The chat assistant runs in the web tier, so it is unaffected.
    expect(caps.chatAssistant.available).toBe(true);
  }, 60_000);

  it("names the exact key each unconfigured feature needs", async () => {
    const caps = await videoCapabilities();

    expect(caps.rendering.available).toBe(true);
    expect(caps.subtitlesAuto.available).toBe(false);
    expect(caps.subtitlesAuto.fix).toMatch(/AI_API_KEY|GOOGLE_AI_API_KEY/);
    expect(caps.sampleAnalysis.available).toBe(false);
    expect(caps.sampleAnalysis.reason).toMatch(/vision model/i);
    expect(caps.sampleAnalysis.fix).toMatch(/GOOGLE_AI_API_KEY/);
    expect(caps.chatAssistant.available).toBe(false);
    expect(caps.chatAssistant.fix).toMatch(/ANTHROPIC_API_KEY/);

    // Local storage on a normal host is usable, and reports its own ceiling.
    expect(caps.storage.available).toBe(true);
    expect(caps.storage.driver).toBe("local");
    expect(caps.storage.maxUploadMb).toBeGreaterThan(0);
  }, 60_000);

  it("turns each feature on as its key arrives, and names the model it will use", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.GOOGLE_AI_API_KEY = "g-test";

    const caps = await videoCapabilities();
    expect(caps.subtitlesAuto).toMatchObject({ available: true, detail: "openai-compatible (whisper-1)" });
    expect(caps.sampleAnalysis.available).toBe(true);
    expect(caps.sampleAnalysis.detail).toMatch(/gemini/i);
    expect(caps.chatAssistant.available).toBe(true);
  }, 60_000);

  it("says local storage cannot work on a serverless host instead of showing it ready", async () => {
    process.env.VERCEL = "1";
    _resetStorageDriver();
    try {
      const caps = await videoCapabilities();
      expect(caps.storage.available).toBe(false);
      expect(caps.storage.reason).toMatch(/serverless/i);
      // An uploaded file would land on a filesystem the worker never sees.
      expect(caps.storage.reason).toMatch(/would not survive|not be visible/i);
    } finally {
      delete process.env.VERCEL;
      _resetStorageDriver();
    }
  }, 60_000);
});
