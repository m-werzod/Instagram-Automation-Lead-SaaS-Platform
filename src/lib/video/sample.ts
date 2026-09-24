import { readFile } from "node:fs/promises";
import { z } from "zod";
import { aiKeyFor } from "@/lib/env";
import { createLogger, errorFields } from "@/lib/logger";
import { ffmpeg } from "./ffmpeg";
import { probeFile, type ProbeResult } from "./probe";
import type { Workspace } from "./workspace";
import { LOOK_PRESETS, SUBTITLE_PRESETS, type EditParams } from "./params";

const log = createLogger("video.sample");

/**
 * "Edit my video like this one."
 *
 * Two layers, deliberately kept apart because they have different standing:
 *
 *   measured — facts extracted with FFmpeg. Scene-cut timestamps, cut cadence,
 *              loudness, letterboxing, speech/silence windows. Reproducible and
 *              checkable.
 *   observed — a vision model's reading of the same video: whether it has
 *              captions, roughly where, how it is paced, how it is graded. An
 *              opinion, labelled as one.
 *
 * The plan they produce marks every operation with what this engine can
 * honestly do about it:
 *
 *   reproducible — the engine applies exactly this (aspect, speed, trim,
 *                  audio mix, subtitle style).
 *   approximate  — the engine does something close, and says so (a "transition"
 *                  becomes a hard cut; a colour grade becomes the nearest look
 *                  preset).
 *   unsupported  — the engine will not attempt it (motion graphics, tracked
 *                  overlays, beat-synced effects, face-aware reframing).
 *
 * Nothing here claims the sample was reproduced. The UI shows the plan, the
 * operator approves it, and only then is anything rendered.
 */

export type Feasibility = "reproducible" | "approximate" | "unsupported";

export interface PlanItem {
  op: string;
  label: string;
  feasibility: Feasibility;
  /** Patch applied to EditParams when the operator accepts this item. */
  patch?: Record<string, unknown>;
  note: string;
}

export interface MeasuredStyle {
  durationSec: number | null;
  width: number | null;
  height: number | null;
  aspectLabel: string;
  fps: number | null;
  hasAudio: boolean;
  /** Timestamps where the picture changes sharply. */
  sceneCuts: number[];
  cutCount: number;
  /** Median seconds between cuts — the sample's pacing. */
  medianCutSec: number | null;
  pacing: "very-fast" | "fast" | "medium" | "slow" | "static";
  /** Integrated loudness (LUFS), when measurable. */
  loudnessLufs: number | null;
  /** Windows where the audio is essentially silent. */
  silenceWindows: Array<{ start: number; end: number }>;
  speechRatio: number | null;
  /** Detected letterbox/pillarbox crop, if the sample is padded. */
  detectedCrop: string | null;
}

export interface ObservedStyle {
  hasSubtitles: boolean | null;
  subtitlePosition: "top" | "middle" | "lower-center" | "bottom" | null;
  subtitleStyleGuess: string | null;
  colorTreatment: string | null;
  pacingDescription: string | null;
  notableEffects: string[];
  summary: string;
}

// ---- measurement ----

/** Scene-change detection; the threshold is FFmpeg's standard "obvious cut". */
async function detectSceneCuts(path: string, signal?: AbortSignal): Promise<number[]> {
  const { stderr } = await ffmpeg(
    ["-hide_banner", "-nostdin", "-i", path, "-filter:v", "select='gt(scene,0.35)',showinfo", "-f", "null", "-"],
    { timeoutMs: 10 * 60_000, signal },
  ).catch((err) => {
    log.warn("scene detection failed", errorFields(err));
    return { stderr: "" } as { stderr: string };
  });

  const out: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) out.push(Math.round(t * 100) / 100);
  }
  return out;
}

async function measureLoudness(path: string, signal?: AbortSignal): Promise<number | null> {
  const { stderr } = await ffmpeg(
    ["-hide_banner", "-nostdin", "-i", path, "-filter:a", "ebur128=framelog=quiet", "-f", "null", "-"],
    { timeoutMs: 5 * 60_000, signal },
  ).catch(() => ({ stderr: "" }) as { stderr: string });
  const m = /I:\s*(-?[0-9.]+)\s*LUFS/.exec(stderr);
  const v = m ? Number(m[1]) : NaN;
  return Number.isFinite(v) ? v : null;
}

async function detectSilence(path: string, signal?: AbortSignal): Promise<Array<{ start: number; end: number }>> {
  const { stderr } = await ffmpeg(
    ["-hide_banner", "-nostdin", "-i", path, "-filter:a", "silencedetect=noise=-32dB:d=0.4", "-f", "null", "-"],
    { timeoutMs: 5 * 60_000, signal },
  ).catch(() => ({ stderr: "" }) as { stderr: string });

  const windows: Array<{ start: number; end: number }> = [];
  let pending: number | null = null;
  for (const line of stderr.split("\n")) {
    const s = /silence_start:\s*(-?[0-9.]+)/.exec(line);
    if (s) pending = Number(s[1]);
    const e = /silence_end:\s*([0-9.]+)/.exec(line);
    if (e && pending !== null) {
      windows.push({ start: Math.max(0, pending), end: Number(e[1]) });
      pending = null;
    }
  }
  return windows;
}

async function detectCrop(path: string, durationSec: number | null, signal?: AbortSignal): Promise<string | null> {
  const start = durationSec && durationSec > 6 ? Math.min(3, durationSec / 4) : 0;
  const { stderr } = await ffmpeg(
    ["-hide_banner", "-nostdin", "-ss", String(start), "-t", "4", "-i", path, "-filter:v", "cropdetect=24:2:0", "-f", "null", "-"],
    { timeoutMs: 3 * 60_000, signal },
  ).catch(() => ({ stderr: "" }) as { stderr: string });
  const matches = [...stderr.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)];
  return matches.length ? (matches[matches.length - 1]?.[1] ?? null) : null;
}

function aspectLabel(w: number | null, h: number | null): string {
  if (!w || !h) return "unknown";
  const r = w / h;
  const closest = [
    { label: "9:16", v: 9 / 16 },
    { label: "4:5", v: 4 / 5 },
    { label: "1:1", v: 1 },
    { label: "16:9", v: 16 / 9 },
  ].sort((a, b) => Math.abs(a.v - r) - Math.abs(b.v - r))[0];
  return closest && Math.abs(closest.v - r) < 0.06 ? closest.label : `${r.toFixed(2)}:1`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] ?? null) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

export async function measureSample(path: string, signal?: AbortSignal): Promise<MeasuredStyle> {
  const probe: ProbeResult = await probeFile(path, signal);
  const duration = probe.durationSec;

  const [cuts, loudness, silence, crop] = await Promise.all([
    detectSceneCuts(path, signal),
    probe.audio ? measureLoudness(path, signal) : Promise.resolve(null),
    probe.audio ? detectSilence(path, signal) : Promise.resolve([]),
    detectCrop(path, duration, signal),
  ]);

  const gaps: number[] = [];
  for (let i = 1; i < cuts.length; i++) gaps.push((cuts[i] ?? 0) - (cuts[i - 1] ?? 0));
  const med = median(gaps);

  const pacing: MeasuredStyle["pacing"] =
    med === null ? "static" : med < 0.8 ? "very-fast" : med < 1.8 ? "fast" : med < 4 ? "medium" : "slow";

  const silentSec = silence.reduce((acc, w) => acc + Math.max(0, w.end - w.start), 0);
  const speechRatio = duration && duration > 0 ? Math.max(0, Math.min(1, 1 - silentSec / duration)) : null;

  return {
    durationSec: duration,
    width: probe.displayWidth,
    height: probe.displayHeight,
    aspectLabel: aspectLabel(probe.displayWidth, probe.displayHeight),
    fps: probe.video?.fps ?? null,
    hasAudio: Boolean(probe.audio),
    sceneCuts: cuts.slice(0, 500),
    cutCount: cuts.length,
    medianCutSec: med === null ? null : Math.round(med * 100) / 100,
    pacing,
    loudnessLufs: loudness,
    silenceWindows: silence.slice(0, 200),
    speechRatio: speechRatio === null ? null : Math.round(speechRatio * 100) / 100,
    detectedCrop: crop,
  };
}

// ---- AI observation ----

const observedSchema = z.object({
  hasSubtitles: z.boolean().nullable().default(null),
  subtitlePosition: z.enum(["top", "middle", "lower-center", "bottom"]).nullable().default(null),
  subtitleStyleGuess: z.string().max(300).nullable().default(null),
  colorTreatment: z.enum(LOOK_PRESETS).nullable().default(null),
  pacingDescription: z.string().max(300).nullable().default(null),
  notableEffects: z.array(z.string().max(120)).max(12).default([]),
  summary: z.string().max(1200).default(""),
});

/**
 * Ask Gemini to describe the sample from sampled frames.
 *
 * Frames rather than the whole file: it keeps the request small enough to be
 * reliable, and the questions asked (captions, framing, grading, pacing) are
 * all answerable from stills plus the measured timing data.
 */
export async function observeSample(
  ws: Workspace,
  path: string,
  measured: MeasuredStyle,
  signal?: AbortSignal,
): Promise<ObservedStyle | null> {
  const key = aiKeyFor("google");
  if (!key) return null;

  const model = process.env.GEMINI_VIDEO_MODEL?.trim() || "gemini-2.5-flash";
  const duration = measured.durationSec ?? 0;
  const points = duration > 0 ? [0.1, 0.3, 0.5, 0.7, 0.9].map((f) => duration * f) : [0];

  const frames: string[] = [];
  for (let i = 0; i < points.length; i++) {
    const out = ws.path(`sample-frame-${i}.jpg`);
    try {
      await ffmpeg(
        ["-hide_banner", "-nostdin", "-y", "-ss", (points[i] ?? 0).toFixed(2), "-i", path, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", out],
        { timeoutMs: 60_000, signal },
      );
      frames.push((await readFile(out)).toString("base64"));
    } catch (err) {
      log.warn("frame extraction failed", { at: points[i], ...errorFields(err) });
    }
  }
  if (frames.length === 0) return null;

  const prompt = [
    "You are analysing the editing STYLE of a short social video from sampled frames.",
    `Measured facts: duration ${duration.toFixed(1)}s, ${measured.width}x${measured.height} (${measured.aspectLabel}), ${measured.cutCount} scene cuts, median ${measured.medianCutSec ?? "n/a"}s between cuts, pacing "${measured.pacing}".`,
    "Answer ONLY with JSON matching exactly this shape:",
    '{"hasSubtitles": true|false|null, "subtitlePosition": "top"|"middle"|"lower-center"|"bottom"|null,',
    '"subtitleStyleGuess": "<short description of caption look, or null>",',
    `"colorTreatment": one of ${LOOK_PRESETS.map((p) => `"${p}"`).join("|")} or null,`,
    '"pacingDescription": "<one sentence>", "notableEffects": ["<short phrase>", ...], "summary": "<2-3 sentences>"}',
    "Judge only what the frames show. Use null when you cannot tell. Do not invent effects.",
  ].join(" ");

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }, ...frames.map((data) => ({ inlineData: { mimeType: "image/jpeg", data } }))],
            },
          ],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
        }),
      },
    );
    if (!res.ok) {
      log.warn("sample observation failed", { status: res.status });
      return null;
    }
    const json = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = observedSchema.safeParse(JSON.parse(cleaned));
    if (!parsed.success) {
      log.warn("sample observation did not match the expected shape");
      return null;
    }
    return parsed.data;
  } catch (err) {
    log.warn("sample observation error", errorFields(err));
    return null;
  }
}

// ---- plan ----

/**
 * Turn measurements and observations into a plan of concrete operations.
 * Every entry says plainly what will happen to it, and only `reproducible` and
 * `approximate` items carry a patch that can actually be applied.
 */
export function buildEditingPlan(measured: MeasuredStyle, observed: ObservedStyle | null, target: { width: number; height: number; durationSec: number | null }): PlanItem[] {
  const plan: PlanItem[] = [];

  // Aspect ratio — exactly reproducible.
  if (["9:16", "4:5", "1:1", "16:9"].includes(measured.aspectLabel)) {
    const targetAspect = target.width / target.height;
    const sampleAspect = (measured.width ?? 0) / (measured.height ?? 1);
    plan.push({
      op: "aspect",
      label: `Match the sample's ${measured.aspectLabel} framing`,
      feasibility: "reproducible",
      patch: { video: { aspect: measured.aspectLabel, fit: "cover" } },
      note:
        Math.abs(targetAspect - sampleAspect) < 0.05
          ? "Your video is already this shape."
          : "Your video will be cropped to fill this shape.",
    });
  }

  // Pacing — honest about what can and cannot be done.
  if (measured.medianCutSec !== null && measured.cutCount >= 3) {
    plan.push({
      op: "pacing",
      label: `Sample is cut every ~${measured.medianCutSec}s (${measured.pacing})`,
      feasibility: "unsupported",
      note: "Re-cutting your footage to this rhythm needs decisions about which moments to keep, which this engine does not make on its own. Use it as guidance when you trim.",
    });
  }

  // Duration — reproducible as a trim.
  if (measured.durationSec && target.durationSec && target.durationSec > measured.durationSec * 1.25) {
    plan.push({
      op: "trim",
      label: `Shorten to the sample's ${Math.round(measured.durationSec)}s`,
      feasibility: "reproducible",
      patch: { video: { trim: { startSec: 0, endSec: Math.round(measured.durationSec) } } },
      note: `Your video is ${Math.round(target.durationSec)}s; this keeps the first ${Math.round(measured.durationSec)}s. Adjust the trim afterwards if the interesting part is elsewhere.`,
    });
  }

  // Colour — approximate by construction.
  const look = observed?.colorTreatment;
  if (look && look !== "none" && (LOOK_PRESETS as readonly string[]).includes(look)) {
    plan.push({
      op: "look",
      label: `Apply a "${look}" colour treatment`,
      feasibility: "approximate",
      patch: { look: { preset: look } },
      note: "Matched to the nearest preset this engine can render, not a copy of the sample's exact grade.",
    });
  }

  // Subtitles — style is reproducible, the words are yours.
  if (observed?.hasSubtitles) {
    const position = observed.subtitlePosition ?? "lower-center";
    const preset = guessSubtitlePreset(observed.subtitleStyleGuess);
    plan.push({
      op: "subtitles",
      label: `Add captions in a "${preset}" style, positioned ${position.replace("-", " ")}`,
      feasibility: "reproducible",
      patch: { subtitles: { burnIn: true, style: { preset, position } } },
      note: "The caption look is reproduced. The words come from your own video's speech, so generate or type them first.",
    });
  }

  // Loudness — approximate.
  if (measured.loudnessLufs !== null) {
    plan.push({
      op: "loudness",
      label: `Sample sits at ${measured.loudnessLufs.toFixed(1)} LUFS`,
      feasibility: "approximate",
      note: "Use it as a level reference when you set the original and music volumes; this engine mixes by percentage, not by matching loudness automatically.",
    });
  }

  // Music.
  if (measured.hasAudio && measured.speechRatio !== null && measured.speechRatio < 0.45) {
    plan.push({
      op: "music",
      label: "Sample is mostly music, with little speech",
      feasibility: "reproducible",
      patch: { audio: { originalVolume: 25 } },
      note: "Lowers your original audio so an uploaded track can lead. Upload the music you want and set its volume.",
    });
  }

  // Anything the model noticed that this engine will not attempt.
  for (const effect of observed?.notableEffects ?? []) {
    plan.push({
      op: "effect",
      label: effect,
      feasibility: "unsupported",
      note: "Noticed in the sample, but this engine does not reconstruct it. Doing it would need a dedicated motion-graphics tool.",
    });
  }

  return plan;
}

function guessSubtitlePreset(description: string | null): (typeof SUBTITLE_PRESETS)[number] {
  const d = (description ?? "").toLowerCase();
  if (/box|background|banner|solid/.test(d)) return "high-contrast";
  if (/word|karaoke|highlight|yellow/.test(d)) return "highlighted-words";
  if (/big|bold|large|thick|caps/.test(d)) return "bold-social";
  if (/thin|small|subtle|minimal/.test(d)) return "minimal";
  if (/serif|professional|broadcast|clean lower/.test(d)) return "professional";
  return "clean-white";
}

/** Apply only the accepted plan items to the current parameters. */
export function planPatch(plan: PlanItem[], acceptedOps: string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const item of plan) {
    if (!acceptedOps.includes(item.op) || !item.patch) continue;
    for (const [section, value] of Object.entries(item.patch)) {
      patch[section] = { ...((patch[section] as object) ?? {}), ...(value as object) };
    }
  }
  return patch;
}

export type { EditParams };
