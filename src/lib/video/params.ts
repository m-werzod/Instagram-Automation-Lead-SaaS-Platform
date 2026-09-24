import { z } from "zod";

/**
 * The edit model — the single source of truth for what a render will do.
 *
 * Everything that can change a video passes through this schema: the timeline
 * UI writes it, the chat assistant may only *propose a patch* to it, and the
 * FFmpeg layer builds its argument list from it. Nothing else reaches the
 * encoder. That is what makes natural-language editing safe: a model's output
 * is data validated against these bounds, never a command, never a filter
 * string, never a file path.
 *
 * Bounds are deliberate and enforced here rather than in the UI, because the
 * UI is not the only caller.
 */

// ---- audio ----

/**
 * Volume is expressed in percent because that is what the product promises
 * ("original 30%, music 100%") and what an operator can reason about. It maps
 * to FFmpeg's linear amplitude multiplier, which is NOT perceptual loudness:
 * 50% is a halved amplitude, roughly -6 dB, and sounds considerably louder than
 * "half as loud". The UI says so rather than implying a perceptual scale.
 */
export const volumePercent = z.number().int().min(0).max(200);

export const audioTrackSchema = z.object({
  /** VideoAsset id, role AUDIO, belonging to the same project. */
  assetId: z.string().min(1),
  volume: volumePercent.default(100),
  /** Where the track starts playing within the video, in seconds. */
  startSec: z.number().min(0).max(86_400).default(0),
  /** Optional in-point/out-point inside the uploaded audio itself. */
  trimStartSec: z.number().min(0).max(86_400).optional(),
  trimEndSec: z.number().min(0).max(86_400).optional(),
  fadeInSec: z.number().min(0).max(60).default(0),
  fadeOutSec: z.number().min(0).max(60).default(0),
  /** Repeat the track until the video ends (typical for background music). */
  loop: z.boolean().default(false),
  /**
   * Duck this track under detected speech in the original audio. Implemented
   * with sidechain compression keyed off the original track; it is an
   * approximation of "make the music quieter while someone is talking", and the
   * UI labels it as one.
   */
  duckUnderSpeech: z.boolean().default(false),
});

export type AudioTrackParams = z.infer<typeof audioTrackSchema>;

export const audioSchema = z.object({
  /** Volume of the video's own audio. Independent of every uploaded track. */
  originalVolume: volumePercent.default(100),
  /** Hard mute, kept separate from volume 0 so the intent survives edits. */
  muteOriginal: z.boolean().default(false),
  tracks: z.array(audioTrackSchema).max(6).default([]),
});

// ---- video ----

export const trimSchema = z
  .object({
    startSec: z.number().min(0).max(86_400).default(0),
    endSec: z.number().min(0).max(86_400).optional(),
  })
  .refine((t) => t.endSec === undefined || t.endSec > t.startSec, {
    message: "Trim end must be after trim start",
  });

/** Instagram's useful shapes, plus the source's own. */
export const ASPECT_PRESETS = ["original", "9:16", "1:1", "4:5", "16:9"] as const;
export type AspectPreset = (typeof ASPECT_PRESETS)[number];

/**
 * How to reach the target aspect ratio. "cover" crops (fills the frame, loses
 * edges); "contain" pads with bars (keeps everything, adds background).
 */
export const FIT_MODES = ["cover", "contain"] as const;

export const videoSchema = z.object({
  trim: trimSchema.optional(),
  /** 0.25x–4x. Audio is pitch-corrected to stay natural. */
  speed: z.number().min(0.25).max(4).default(1),
  aspect: z.enum(ASPECT_PRESETS).default("original"),
  fit: z.enum(FIT_MODES).default("cover"),
  /** Padding colour for "contain", as #rrggbb. */
  padColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default("#000000"),
  /** Cap the long edge; keeps exports inside Instagram's limits. */
  maxHeight: z.number().int().min(240).max(2160).optional(),
});

// ---- colour / look ----

/**
 * A small, fixed set of colour treatments. Deliberately closed: every entry
 * maps to a known-good FFmpeg filter chain, so a sample-analysis "make it look
 * like this" can only ever select from treatments that actually render.
 */
export const LOOK_PRESETS = ["none", "vivid", "warm", "cool", "soft", "contrast", "bw"] as const;
export type LookPreset = (typeof LOOK_PRESETS)[number];

export const lookSchema = z.object({
  preset: z.enum(LOOK_PRESETS).default("none"),
  brightness: z.number().min(-0.5).max(0.5).default(0),
  contrast: z.number().min(0.5).max(2).default(1),
  saturation: z.number().min(0).max(3).default(1),
});

// ---- subtitles ----

export const SUBTITLE_PRESETS = [
  "clean-white",
  "bold-social",
  "minimal",
  "high-contrast",
  "creator",
  "highlighted-words",
  "professional",
] as const;
export type SubtitlePreset = (typeof SUBTITLE_PRESETS)[number];

export const SUBTITLE_POSITIONS = ["top", "middle", "lower-center", "bottom"] as const;

/**
 * Subtitle appearance. Rendered through a generated ASS file, never through an
 * interpolated filter string — see src/lib/video/subtitles.ts.
 *
 * The font must cover Latin, Cyrillic and Uzbek Latin (including oʻ/gʻ), so the
 * default is a widely-available family and the renderer verifies the chosen one
 * exists before burning it in.
 */
export const subtitleStyleSchema = z.object({
  preset: z.enum(SUBTITLE_PRESETS).default("clean-white"),
  fontFamily: z.string().min(1).max(64).default("DejaVu Sans"),
  fontSizePct: z.number().min(2).max(14).default(5.5),
  bold: z.boolean().default(true),
  italic: z.boolean().default(false),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#000000"),
  backgroundOpacity: z.number().min(0).max(1).default(0),
  outlineColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#000000"),
  outlineWidth: z.number().min(0).max(8).default(2),
  shadow: z.number().min(0).max(8).default(0),
  position: z.enum(SUBTITLE_POSITIONS).default("lower-center"),
  marginVerticalPct: z.number().min(0).max(45).default(12),
  alignment: z.enum(["left", "center", "right"]).default("center"),
  lineSpacing: z.number().min(0).max(40).default(0),
  /** Uppercase the rendered text (a common social style). */
  uppercase: z.boolean().default(false),
  /**
   * Highlight each word as it is spoken. Requires word-level timings from the
   * transcription provider; when those are absent the renderer falls back to
   * cue-level display rather than inventing timings.
   */
  wordHighlight: z.boolean().default(false),
  wordHighlightColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFD400"),
});

export type SubtitleStyle = z.infer<typeof subtitleStyleSchema>;

/**
 * Ready-made looks. Selecting a preset must actually change how captions render,
 * so a patch that names one starts from these values (see applyEditPatch) rather
 * than only relabelling the current style.
 */
export const SUBTITLE_PRESET_STYLES: Record<SubtitlePreset, Partial<SubtitleStyle>> = {
  "clean-white": {
    fontSizePct: 5.2, bold: true, textColor: "#FFFFFF", outlineColor: "#000000", outlineWidth: 2,
    backgroundOpacity: 0, shadow: 0, position: "lower-center", uppercase: false, wordHighlight: false,
  },
  "bold-social": {
    fontSizePct: 7, bold: true, textColor: "#FFFFFF", outlineColor: "#000000", outlineWidth: 3.5,
    backgroundOpacity: 0, shadow: 1, position: "lower-center", uppercase: true, wordHighlight: false,
  },
  minimal: {
    fontSizePct: 4.2, bold: false, textColor: "#FFFFFF", outlineColor: "#000000", outlineWidth: 1,
    backgroundOpacity: 0, shadow: 0, position: "bottom", uppercase: false, wordHighlight: false,
  },
  "high-contrast": {
    fontSizePct: 5.5, bold: true, textColor: "#FFFFFF", backgroundColor: "#000000", backgroundOpacity: 0.85,
    outlineWidth: 0, shadow: 0, position: "lower-center", uppercase: false, wordHighlight: false,
  },
  creator: {
    fontSizePct: 6.5, bold: true, textColor: "#FFFFFF", outlineColor: "#111111", outlineWidth: 3,
    shadow: 2, backgroundOpacity: 0, position: "middle", uppercase: true, wordHighlight: false,
  },
  "highlighted-words": {
    fontSizePct: 6.5, bold: true, textColor: "#FFFFFF", outlineColor: "#000000", outlineWidth: 3,
    backgroundOpacity: 0, position: "lower-center", wordHighlight: true, wordHighlightColor: "#FFD400", uppercase: true,
  },
  professional: {
    fontSizePct: 4.6, bold: false, textColor: "#FFFFFF", backgroundColor: "#1A1A1A", backgroundOpacity: 0.7,
    outlineWidth: 0, shadow: 0, position: "bottom", uppercase: false, wordHighlight: false,
  },
};

export const subtitlesSchema = z.object({
  /** SubtitleTrack id to render. Null renders none. */
  trackId: z.string().nullable().default(null),
  burnIn: z.boolean().default(true),
  style: subtitleStyleSchema.default({}),
});

// ---- the whole edit ----

export const editParamsSchema = z.object({
  video: videoSchema.default({}),
  audio: audioSchema.default({}),
  look: lookSchema.default({}),
  subtitles: subtitlesSchema.default({}),
});

export type EditParams = z.infer<typeof editParamsSchema>;

export function defaultEditParams(): EditParams {
  return editParamsSchema.parse({});
}

/**
 * Merge a partial patch (typically produced by the chat assistant) onto the
 * current parameters and re-validate the whole result.
 *
 * Merging is deliberately shallow-per-section: a patch that touches `audio`
 * replaces the audio section wholesale after being merged field-by-field, so a
 * model cannot half-specify a track and leave a nonsensical combination behind.
 * Anything the patch does not mention is preserved exactly.
 */
/**
 * Merge a subtitle-style patch.
 *
 * Naming a different preset applies that preset's whole look, then anything the
 * patch says explicitly on top. Without this a preset button would change only
 * the stored preset name and leave every visual field at its previous value —
 * the control would appear to work and render identically.
 */
export function mergeSubtitleStyle(current: SubtitleStyle, patch?: Record<string, unknown>): SubtitleStyle {
  if (!patch) return current;
  const nextPreset = patch.preset as SubtitlePreset | undefined;
  const base =
    nextPreset && nextPreset !== current.preset
      ? { ...current, ...SUBTITLE_PRESET_STYLES[nextPreset], preset: nextPreset }
      : current;
  return subtitleStyleSchema.parse({ ...base, ...patch });
}

export function applyEditPatch(current: EditParams, patch: unknown): EditParams {
  const p = (patch ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {
    video: { ...current.video, ...((p.video as object) ?? {}) },
    audio: {
      ...current.audio,
      ...((p.audio as object) ?? {}),
      // tracks replace as a unit: a partial array would be ambiguous
      tracks: (p.audio as { tracks?: unknown })?.tracks ?? current.audio.tracks,
    },
    look: { ...current.look, ...((p.look as object) ?? {}) },
    subtitles: {
      ...current.subtitles,
      ...((p.subtitles as object) ?? {}),
      style: mergeSubtitleStyle(current.subtitles.style, (p.subtitles as { style?: Record<string, unknown> })?.style),
    },
  };
  return editParamsSchema.parse(merged);
}

/**
 * Human-readable diff between two parameter sets, used to show the operator
 * exactly what an AI proposal would change before they accept it. Keys are
 * dictionary lookups so the summary can be shown in Uzbek, Russian or English.
 */
export interface ParamChange {
  path: string;
  from: string;
  to: string;
}

export function diffEditParams(a: EditParams, b: EditParams): ParamChange[] {
  const out: ParamChange[] = [];
  const walk = (x: unknown, y: unknown, path: string) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    const bothPlain =
      x && y && typeof x === "object" && typeof y === "object" && !Array.isArray(x) && !Array.isArray(y);
    if (bothPlain) {
      const keys = new Set([...Object.keys(x as object), ...Object.keys(y as object)]);
      for (const k of keys) {
        walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    out.push({ path, from: render(x), to: render(y) });
  };
  walk(a, b, "");
  return out;
}

function render(v: unknown): string {
  if (v === undefined) return "—";
  if (v === null) return "none";
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? "" : "s"}`;
  if (typeof v === "object") return JSON.stringify(v).slice(0, 80);
  return String(v);
}

// ---- export targets ----

/**
 * Instagram's published limits for the formats this product publishes. Used to
 * warn honestly before an export rather than letting Meta reject it later.
 * Values are Meta's documented constraints, not guesses; anything uncertain is
 * left out rather than invented.
 */
export const REELS_LIMITS = {
  maxDurationSec: 900,
  minDurationSec: 3,
  recommendedAspect: "9:16",
  maxFileBytes: 1024 * 1024 * 1024,
  container: "mp4",
  videoCodec: "h264",
  audioCodec: "aac",
} as const;

export const STORY_LIMITS = {
  maxDurationSec: 60,
  minDurationSec: 1,
  recommendedAspect: "9:16",
} as const;

export interface ExportWarning {
  code: string;
  detail: string;
}

/**
 * Check a finished render against the target surface. Returns warnings, not
 * errors: the platform never silently blocks an upload Meta might accept, it
 * tells the operator what Instagram is likely to do.
 */
export function checkExportForInstagram(input: {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  sizeBytes: number;
  target: "REELS" | "STORIES" | "FEED";
}): ExportWarning[] {
  const out: ExportWarning[] = [];
  const { durationSec, width, height, sizeBytes, target } = input;

  if (target === "REELS" && durationSec !== null) {
    if (durationSec > REELS_LIMITS.maxDurationSec) {
      out.push({ code: "REEL_TOO_LONG", detail: `${Math.round(durationSec)}s exceeds the ${REELS_LIMITS.maxDurationSec}s Reels limit.` });
    }
    if (durationSec < REELS_LIMITS.minDurationSec) {
      out.push({ code: "REEL_TOO_SHORT", detail: `${durationSec.toFixed(1)}s is below the ${REELS_LIMITS.minDurationSec}s minimum.` });
    }
  }
  if (target === "STORIES" && durationSec !== null && durationSec > STORY_LIMITS.maxDurationSec) {
    out.push({ code: "STORY_TOO_LONG", detail: `${Math.round(durationSec)}s exceeds the ${STORY_LIMITS.maxDurationSec}s Stories limit; Instagram splits or rejects longer clips.` });
  }
  if (sizeBytes > REELS_LIMITS.maxFileBytes) {
    out.push({ code: "FILE_TOO_LARGE", detail: `${(sizeBytes / 1024 / 1024).toFixed(0)} MB is above the 1 GB upload limit.` });
  }
  if (width && height) {
    const ratio = width / height;
    if ((target === "REELS" || target === "STORIES") && Math.abs(ratio - 9 / 16) > 0.08) {
      out.push({
        code: "ASPECT_NOT_VERTICAL",
        detail: `The render is ${width}×${height}. Reels and Stories display 9:16 — other ratios get cropped or padded by Instagram.`,
      });
    }
  }
  return out;
}
