import { spawn } from "node:child_process";
import { createLogger, errorFields } from "@/lib/logger";

const log = createLogger("video.ffmpeg");

/**
 * FFmpeg process layer — the ONLY place in the product that executes a binary.
 *
 * Two rules hold everywhere in this file, and are what make AI-authored edits
 * safe to run:
 *
 *  1. Arguments are always an array passed to spawn() with `shell: false`.
 *     There is no command string anywhere, so no user text — and no model
 *     output — can ever be interpreted as shell syntax. Section 10/12 of the
 *     spec requires this: the assistant proposes structured parameters, and
 *     this layer turns validated parameters into argv.
 *  2. Text that must reach FFmpeg (subtitles, overlays) is written to a file we
 *     create and referenced by path, never interpolated into a filtergraph.
 *
 * Every run is bounded by a timeout and an AbortSignal so a hung encode cannot
 * outlive its job lease.
 */

export const FFMPEG_BIN = process.env.FFMPEG_PATH?.trim() || "ffmpeg";
export const FFPROBE_BIN = process.env.FFPROBE_PATH?.trim() || "ffprobe";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class FfmpegError extends Error {
  readonly code: number;
  /** Tail of stderr — what actually explains the failure. */
  readonly stderrTail: string;
  constructor(bin: string, code: number, stderr: string) {
    const tail = stderr.split("\n").filter(Boolean).slice(-6).join("\n");
    super(`${bin} exited ${code}: ${tail.slice(0, 600)}`);
    this.name = "FfmpegError";
    this.code = code;
    this.stderrTail = tail;
  }
}

export class FfmpegMissingError extends Error {
  constructor(bin: string) {
    super(
      `${bin} is not installed or not on PATH. Video processing requires FFmpeg on the machine running the worker — see MANUAL_SETUP_GUIDE.md, "Video processing worker".`,
    );
    this.name = "FfmpegMissingError";
  }
}

export interface RunOptions {
  /** Hard ceiling for this invocation. */
  timeoutMs?: number;
  /** Cancels the run (job cancelled, lease lost, worker shutting down). */
  signal?: AbortSignal;
  /** Called with each stderr chunk — FFmpeg reports progress there. */
  onStderr?: (chunk: string) => void;
  /** Keep at most this much stderr in memory (the tail is what matters). */
  maxStderrChars?: number;
}

/**
 * Spawn a binary with an argument ARRAY (never a shell string) and collect its
 * output. Rejects on non-zero exit, timeout, abort, or a missing binary.
 */
export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const maxStderr = opts.maxStderrChars ?? 64_000;

  return new Promise<RunResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const child = spawn(bin, args, {
      shell: false, // never a shell: argv only
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > maxStderr) stdout = stdout.slice(-maxStderr);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      opts.onStderr?.(text);
      stderr += text;
      if (stderr.length > maxStderr) stderr = stderr.slice(-maxStderr);
    });

    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`${bin} exceeded its ${Math.round(timeoutMs / 1000)}s budget`));
      });
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`${bin} run cancelled`));
      });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    function cleanup() {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      finish(() => reject(err.code === "ENOENT" ? new FfmpegMissingError(bin) : err));
    });

    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve({ code: 0, stdout, stderr });
        else reject(new FfmpegError(bin, code ?? -1, stderr));
      });
    });
  });
}

export function ffmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(FFMPEG_BIN, args, opts);
}

export function ffprobe(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return run(FFPROBE_BIN, args, opts);
}

// ---- availability ----

export interface FfmpegAvailability {
  available: boolean;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  /** Why it is unavailable, in words an admin can act on. */
  reason: string | null;
}

let cached: { at: number; value: FfmpegAvailability } | null = null;
const AVAILABILITY_TTL_MS = 60_000;

function parseVersion(stdout: string): string | null {
  const first = stdout.split("\n")[0]?.trim();
  return first || null;
}

/**
 * Probe both binaries. Cached briefly so status endpoints can call it freely.
 * Never throws — an unavailable FFmpeg is a reported state, not a crash.
 */
export async function ffmpegAvailability(force = false): Promise<FfmpegAvailability> {
  if (!force && cached && Date.now() - cached.at < AVAILABILITY_TTL_MS) return cached.value;

  const value: FfmpegAvailability = { available: false, ffmpegVersion: null, ffprobeVersion: null, reason: null };
  try {
    const [a, b] = await Promise.all([
      run(FFMPEG_BIN, ["-version"], { timeoutMs: 10_000 }),
      run(FFPROBE_BIN, ["-version"], { timeoutMs: 10_000 }),
    ]);
    value.ffmpegVersion = parseVersion(a.stdout);
    value.ffprobeVersion = parseVersion(b.stdout);
    value.available = true;
  } catch (err) {
    value.reason =
      err instanceof FfmpegMissingError
        ? err.message
        : `FFmpeg could not be started: ${err instanceof Error ? err.message : String(err)}`;
    log.warn("ffmpeg unavailable", errorFields(err));
  }
  cached = { at: Date.now(), value };
  return value;
}

/** Cheap boolean for the worker's lane decision. */
export async function hasFfmpeg(): Promise<boolean> {
  return (await ffmpegAvailability()).available;
}

// ---- progress parsing ----

/**
 * FFmpeg writes `time=00:01:23.45` lines to stderr. Turning that into a percent
 * needs the known duration; callers that lack one report elapsed time instead.
 */
export function parseProgressSeconds(chunk: string): number | null {
  const m = /time=(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(chunk);
  if (!m) return null;
  const [, h, min, sec] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(sec);
}
