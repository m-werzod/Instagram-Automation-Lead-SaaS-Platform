import type { EditParams, LookPreset } from "./params";

/**
 * Filtergraph construction — validated parameters in, FFmpeg argv out.
 *
 * Nothing in this file accepts free text. Every value has already passed the
 * zod schema in params.ts, and the only string that reaches a filter is a file
 * path this process created (the generated ASS subtitle file). That is the
 * boundary that lets an AI assistant drive editing safely: it proposes
 * parameters, and parameters are all this layer can express.
 */

export interface RenderInput {
  /** Absolute path to the source video. */
  sourcePath: string;
  /** Absolute paths for each audio track, in the same order as params.audio.tracks. */
  audioPaths: string[];
  /**
   * The generated .ass file, when subtitles are burned in. The job layer passes
   * a bare filename and runs FFmpeg from the workspace, because a filtergraph
   * cannot express every absolute path (see RunOptions.cwd); an absolute path
   * still works wherever one is expressible.
   */
  subtitlePath?: string | null;
  outputPath: string;
  params: EditParams;
  /** Probed source facts, used to resolve percentages and aspect targets. */
  source: { width: number; height: number; durationSec: number | null; hasAudio: boolean };
  /** Preview renders trade quality for speed. */
  quality: "preview" | "export";
}

const LOOK_FILTERS: Record<LookPreset, string | null> = {
  none: null,
  vivid: "eq=saturation=1.35:contrast=1.12",
  warm: "colortemperature=temperature=7200",
  cool: "colortemperature=temperature=4800",
  soft: "eq=contrast=0.92:brightness=0.03:saturation=0.95",
  contrast: "eq=contrast=1.35",
  bw: "hue=s=0",
};

function aspectRatio(preset: EditParams["video"]["aspect"], src: { width: number; height: number }): number | null {
  switch (preset) {
    case "9:16":
      return 9 / 16;
    case "1:1":
      return 1;
    case "4:5":
      return 4 / 5;
    case "16:9":
      return 16 / 9;
    default:
      return src.height > 0 ? src.width / src.height : null;
  }
}

/** FFmpeg wants even dimensions for H.264 chroma subsampling. */
function even(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r + 1;
}

export interface TargetSize {
  width: number;
  height: number;
}

export function resolveTargetSize(params: EditParams, source: { width: number; height: number }, quality: "preview" | "export"): TargetSize {
  const ratio = aspectRatio(params.video.aspect, source) ?? 9 / 16;
  const cap = quality === "preview" ? 640 : (params.video.maxHeight ?? 1920);
  let height = Math.min(source.height || cap, cap);
  if (height <= 0) height = cap;
  let width = height * ratio;
  const maxWidth = quality === "preview" ? 640 : 1920;
  if (width > maxWidth) {
    width = maxWidth;
    height = width / ratio;
  }
  return { width: even(width), height: even(height) };
}

/**
 * Escape a filesystem path for use inside a filtergraph argument. FFmpeg's
 * parser treats `:` as an option separator and `'` as a quote, and Windows
 * paths contain both a drive colon and backslashes.
 */
export function escapeFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

interface BuiltGraph {
  args: string[];
  /** Duration the output is expected to have, for progress reporting. */
  expectedDurationSec: number | null;
}

/**
 * Build the complete FFmpeg invocation.
 *
 * Structure: inputs, then a filter_complex that produces one video stream and
 * (optionally) one audio stream, then encoder settings. Video and audio are
 * built independently, which is what makes the product's core promise work —
 * the original track's volume and each uploaded track's volume are separate
 * controls, not one balance slider.
 */
export function buildRenderArgs(input: RenderInput): BuiltGraph {
  const { params, source, quality } = input;
  const args: string[] = ["-hide_banner", "-nostdin", "-y"];

  // ---- inputs ----
  const trim = params.video.trim;
  if (trim?.startSec) args.push("-ss", trim.startSec.toFixed(3));
  if (trim?.endSec !== undefined) args.push("-to", trim.endSec.toFixed(3));
  args.push("-i", input.sourcePath);

  params.audio.tracks.forEach((track, i) => {
    const path = input.audioPaths[i];
    if (!path) return;
    // Looping must be requested before the input it applies to.
    if (track.loop) args.push("-stream_loop", "-1");
    args.push("-i", path);
  });

  // ---- video chain ----
  const target = resolveTargetSize(params, source, quality);
  const vf: string[] = [];

  // Rotation metadata is applied by the decoder; transpose is not needed here.
  if (params.video.speed !== 1) {
    vf.push(`setpts=${(1 / params.video.speed).toFixed(6)}*PTS`);
  }

  if (params.video.fit === "cover") {
    vf.push(`scale=${target.width}:${target.height}:force_original_aspect_ratio=increase`);
    vf.push(`crop=${target.width}:${target.height}`);
  } else {
    vf.push(`scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease`);
    vf.push(
      `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:${params.video.padColor.replace("#", "0x")}`,
    );
  }

  const look = LOOK_FILTERS[params.look.preset];
  if (look) vf.push(look);
  const manualEq: string[] = [];
  if (params.look.brightness !== 0) manualEq.push(`brightness=${params.look.brightness.toFixed(3)}`);
  if (params.look.contrast !== 1) manualEq.push(`contrast=${params.look.contrast.toFixed(3)}`);
  if (params.look.saturation !== 1) manualEq.push(`saturation=${params.look.saturation.toFixed(3)}`);
  if (manualEq.length) vf.push(`eq=${manualEq.join(":")}`);

  if (input.subtitlePath && params.subtitles.burnIn) {
    // The text lives in the file; only its path appears in the graph.
    vf.push(`subtitles='${escapeFilterPath(input.subtitlePath)}'`);
  }

  vf.push("format=yuv420p");
  vf.push("setsar=1");

  const filterParts: string[] = [`[0:v]${vf.join(",")}[vout]`];

  // ---- audio chain ----
  const audioLabels: string[] = [];
  const useOriginal = source.hasAudio && !params.audio.muteOriginal && params.audio.originalVolume > 0;

  if (useOriginal) {
    const chain = [`volume=${(params.audio.originalVolume / 100).toFixed(4)}`];
    if (params.video.speed !== 1) chain.push(...atempoChain(params.video.speed));
    filterParts.push(`[0:a]${chain.join(",")}[a_orig]`);
    audioLabels.push("a_orig");
  }

  params.audio.tracks.forEach((track, i) => {
    if (!input.audioPaths[i]) return;
    const label = `a_t${i}`;
    const chain: string[] = [];

    if (track.trimStartSec !== undefined || track.trimEndSec !== undefined) {
      const start = track.trimStartSec ?? 0;
      const end = track.trimEndSec;
      chain.push(end !== undefined ? `atrim=start=${start}:end=${end}` : `atrim=start=${start}`);
      chain.push("asetpts=PTS-STARTPTS");
    }
    if (track.startSec > 0) {
      const ms = Math.round(track.startSec * 1000);
      // adelay needs one value per channel; "all" applies it to every channel.
      chain.push(`adelay=${ms}:all=1`);
    }
    chain.push(`volume=${(track.volume / 100).toFixed(4)}`);
    if (track.fadeInSec > 0) chain.push(`afade=t=in:st=${track.startSec.toFixed(3)}:d=${track.fadeInSec.toFixed(3)}`);
    if (track.fadeOutSec > 0 && source.durationSec) {
      const outStart = Math.max(0, effectiveDuration(params, source.durationSec) - track.fadeOutSec);
      chain.push(`afade=t=out:st=${outStart.toFixed(3)}:d=${track.fadeOutSec.toFixed(3)}`);
    }
    filterParts.push(`[${i + 1}:a]${chain.join(",")}[${label}]`);
    audioLabels.push(label);
  });

  let audioOut: string | null = null;
  if (audioLabels.length === 1) {
    audioOut = audioLabels[0] ?? null;
  } else if (audioLabels.length > 1) {
    /**
     * Ducking is applied before the mix, keyed off the original audio: the
     * sidechain compressor lowers the music whenever the original track has
     * signal. It approximates "quieter during speech" — it reacts to any sound,
     * not to speech specifically — and the UI says so.
     */
    const duckIdx = params.audio.tracks.findIndex((t) => t.duckUnderSpeech);
    if (useOriginal && duckIdx >= 0 && input.audioPaths[duckIdx]) {
      const musicLabel = `a_t${duckIdx}`;
      filterParts.push(`[a_orig]asplit=2[a_orig_mix][a_key]`);
      filterParts.push(
        `[${musicLabel}][a_key]sidechaincompress=threshold=0.05:ratio=8:attack=25:release=350[${musicLabel}_duck]`,
      );
      const mixInputs = audioLabels
        .map((l) => (l === "a_orig" ? "a_orig_mix" : l === musicLabel ? `${musicLabel}_duck` : l))
        .map((l) => `[${l}]`)
        .join("");
      filterParts.push(`${mixInputs}amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0[aout]`);
    } else {
      const mixInputs = audioLabels.map((l) => `[${l}]`).join("");
      filterParts.push(`${mixInputs}amix=inputs=${audioLabels.length}:normalize=0:dropout_transition=0[aout]`);
    }
    audioOut = "aout";
  }

  args.push("-filter_complex", filterParts.join(";"));
  args.push("-map", "[vout]");
  if (audioOut) args.push("-map", `[${audioOut}]`);
  else args.push("-an");

  // A looped or long music track must not extend the video past its own end.
  if (audioOut && params.audio.tracks.some((t) => t.loop)) args.push("-shortest");

  /**
   * Cap the render at the length of the picture.
   *
   * amix runs to its LONGEST input, so a fifteen-second clip with a
   * three-minute song attached was muxed as a three-minute file: the picture
   * froze on its last frame and the song played on over it. Instagram rejects
   * the result and the operator is never told why.
   *
   * `-shortest` is the wrong tool for this. With the original muted and a
   * two-second sting uploaded, the shortest stream is the AUDIO, and it would
   * cut the picture down to two seconds — destroying the edit instead of
   * trimming the overhang. The video's own expected length is the correct
   * ceiling, and it is already computed for the progress bar.
   *
   * Only applied when an uploaded track is actually mapped: the source's own
   * audio ends with the picture by construction, and a source whose duration
   * was never probed has no ceiling to apply.
   */
  const hasUploadedTrack = params.audio.tracks.some((_, i) => Boolean(input.audioPaths[i]));
  const capSec = source.durationSec ? effectiveDuration(params, source.durationSec) : null;
  if (audioOut && hasUploadedTrack && capSec !== null && capSec > 0) args.push("-t", capSec.toFixed(3));

  // ---- encoder ----
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (quality === "preview") {
    args.push("-preset", "veryfast", "-crf", "30", "-r", "24");
  } else {
    args.push("-preset", "medium", "-crf", "20", "-profile:v", "high", "-level", "4.1");
  }
  if (audioOut) args.push("-c:a", "aac", "-b:a", quality === "preview" ? "96k" : "192k", "-ar", "48000");
  // faststart puts the index first so the file starts playing before it is
  // fully downloaded — Meta and every browser player need this.
  args.push("-movflags", "+faststart");
  args.push("-map_metadata", "-1");
  args.push(input.outputPath);

  return { args, expectedDurationSec: source.durationSec ? effectiveDuration(params, source.durationSec) : null };
}

/** Duration after trim and speed — what progress should be measured against. */
export function effectiveDuration(params: EditParams, sourceDurationSec: number): number {
  const start = params.video.trim?.startSec ?? 0;
  const end = params.video.trim?.endSec ?? sourceDurationSec;
  const trimmed = Math.max(0, Math.min(end, sourceDurationSec) - start);
  return trimmed / params.video.speed;
}

/**
 * atempo only accepts 0.5–2.0 per instance, so larger changes are composed from
 * several. Using atempo (rather than resampling) is what keeps a sped-up voice
 * sounding natural instead of chipmunked.
 */
export function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let remaining = speed;
  while (remaining > 2) {
    out.push("atempo=2.0");
    remaining /= 2;
  }
  while (remaining < 0.5) {
    out.push("atempo=0.5");
    remaining *= 2;
  }
  if (Math.abs(remaining - 1) > 0.001) out.push(`atempo=${remaining.toFixed(6)}`);
  return out;
}

/** Extract a single frame as a JPEG — used for thumbnails and Reel covers. */
export function buildThumbnailArgs(sourcePath: string, outputPath: string, atSec: number, width = 720): string[] {
  return [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-ss",
    Math.max(0, atSec).toFixed(3),
    "-i",
    sourcePath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${even(width)}:-2`,
    "-q:v",
    "3",
    outputPath,
  ];
}

/**
 * Extract audio for speech-to-text: 16 kHz mono, which every transcription
 * model expects and which is ~100× smaller than the source video.
 */
export function buildAudioExtractArgs(sourcePath: string, outputPath: string, opts: { startSec?: number; durationSec?: number } = {}): string[] {
  const args = ["-hide_banner", "-nostdin", "-y"];
  if (opts.startSec) args.push("-ss", opts.startSec.toFixed(3));
  args.push("-i", sourcePath);
  if (opts.durationSec) args.push("-t", opts.durationSec.toFixed(3));
  args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", outputPath);
  return args;
}
