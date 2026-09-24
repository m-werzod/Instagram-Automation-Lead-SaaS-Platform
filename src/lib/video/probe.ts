import { ffprobe } from "./ffmpeg";

/**
 * Media inspection. Every fact the editor states about a file — duration,
 * dimensions, whether it even has audio — comes from ffprobe, never from the
 * filename, the browser's MIME string, or an assumption.
 *
 * This is also the platform's only real defence against a hostile upload: a
 * file that ffprobe cannot parse as audio/video is rejected before anything
 * else touches it.
 */

export interface ProbeStreamVideo {
  index: number;
  codec: string;
  width: number;
  height: number;
  fps: number | null;
  /** Rotation from container metadata; portrait phone video is often 90°. */
  rotation: number;
  pixFmt: string | null;
}

export interface ProbeStreamAudio {
  index: number;
  codec: string;
  channels: number;
  sampleRate: number | null;
}

export interface ProbeResult {
  durationSec: number | null;
  sizeBytes: number | null;
  formatName: string | null;
  bitrate: number | null;
  video: ProbeStreamVideo | null;
  audio: ProbeStreamAudio | null;
  /** Display dimensions with rotation applied — what a viewer actually sees. */
  displayWidth: number | null;
  displayHeight: number | null;
  raw: unknown;
}

interface RawProbe {
  streams?: Array<{
    index: number;
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    channels?: number;
    sample_rate?: string;
    pix_fmt?: string;
    tags?: Record<string, string>;
    side_data_list?: Array<{ rotation?: number }>;
  }>;
  format?: {
    duration?: string;
    size?: string;
    format_name?: string;
    bit_rate?: string;
  };
}

function parseFps(value: string | undefined): number | null {
  if (!value) return null;
  const [num, den] = value.split("/").map(Number);
  if (num === undefined || den === undefined) return null;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps * 1000) / 1000 : null;
}

function parseRotation(stream: NonNullable<RawProbe["streams"]>[number]): number {
  const fromSide = stream.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation;
  if (typeof fromSide === "number") return ((Math.round(fromSide) % 360) + 360) % 360;
  const fromTag = Number(stream.tags?.rotate);
  if (Number.isFinite(fromTag)) return ((Math.round(fromTag) % 360) + 360) % 360;
  return 0;
}

/**
 * Probe a file on disk. `-v error` keeps stderr clean so a failure message is
 * the actual reason rather than banner noise.
 */
export async function probeFile(path: string, signal?: AbortSignal): Promise<ProbeResult> {
  const { stdout } = await ffprobe(
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
    { timeoutMs: 120_000, signal },
  );

  let raw: RawProbe;
  try {
    raw = JSON.parse(stdout) as RawProbe;
  } catch {
    throw new Error("ffprobe returned output that could not be parsed — the file is probably not valid media.");
  }

  const v = raw.streams?.find((s) => s.codec_type === "video" && (s.width ?? 0) > 0);
  const a = raw.streams?.find((s) => s.codec_type === "audio");

  const video: ProbeStreamVideo | null = v
    ? {
        index: v.index,
        codec: v.codec_name ?? "unknown",
        width: v.width ?? 0,
        height: v.height ?? 0,
        fps: parseFps(v.avg_frame_rate) ?? parseFps(v.r_frame_rate),
        rotation: parseRotation(v),
        pixFmt: v.pix_fmt ?? null,
      }
    : null;

  const audio: ProbeStreamAudio | null = a
    ? {
        index: a.index,
        codec: a.codec_name ?? "unknown",
        channels: a.channels ?? 0,
        sampleRate: a.sample_rate ? Number(a.sample_rate) : null,
      }
    : null;

  const swapped = video ? video.rotation === 90 || video.rotation === 270 : false;
  const duration = raw.format?.duration ? Number(raw.format.duration) : null;

  return {
    durationSec: Number.isFinite(duration) ? duration : null,
    sizeBytes: raw.format?.size ? Number(raw.format.size) : null,
    formatName: raw.format?.format_name ?? null,
    bitrate: raw.format?.bit_rate ? Number(raw.format.bit_rate) : null,
    video,
    audio,
    displayWidth: video ? (swapped ? video.height : video.width) : null,
    displayHeight: video ? (swapped ? video.width : video.height) : null,
    raw,
  };
}

export class UnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMediaError";
  }
}

/**
 * Validate an uploaded file for a given role. Runs after the bytes have landed
 * but before the asset is marked READY, so a file that is not what it claims to
 * be never becomes usable.
 */
export async function validateUpload(
  path: string,
  role: "SOURCE" | "AUDIO" | "SAMPLE",
  signal?: AbortSignal,
): Promise<ProbeResult> {
  let probe: ProbeResult;
  try {
    probe = await probeFile(path, signal);
  } catch (err) {
    throw new UnsupportedMediaError(
      `This file could not be read as media. ${err instanceof Error ? err.message : ""}`.trim(),
    );
  }

  if (role === "AUDIO") {
    if (!probe.audio) throw new UnsupportedMediaError("This file has no audio track.");
  } else {
    if (!probe.video) throw new UnsupportedMediaError("This file has no video track.");
    if (!probe.durationSec || probe.durationSec <= 0) {
      throw new UnsupportedMediaError("The video has no usable duration — it may be corrupt or still uploading.");
    }
    const maxSec = Number(process.env.VIDEO_MAX_DURATION_SEC) || 3600;
    if (probe.durationSec > maxSec) {
      throw new UnsupportedMediaError(
        `The video is ${Math.round(probe.durationSec / 60)} minutes long; this editor accepts up to ${Math.round(maxSec / 60)} minutes.`,
      );
    }
  }
  return probe;
}
