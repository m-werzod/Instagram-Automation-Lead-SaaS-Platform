import { z } from "zod";
import { subtitleStyleSchema, SUBTITLE_PRESET_STYLES, type SubtitlePreset, type SubtitleStyle } from "./params";

export { SUBTITLE_PRESET_STYLES };

/**
 * Subtitle generation and styling.
 *
 * Text reaches FFmpeg only as a **file** (ASS or SRT) that this module writes,
 * never interpolated into a filtergraph. That is a security property, not a
 * stylistic one: caption text comes from speech-to-text, from an operator, and
 * sometimes from an AI proposal, and a filtergraph is a syntax where a stray
 * quote or colon changes the command's meaning.
 *
 * ASS is used for burn-in because it is the only format that carries the styling
 * this product promises — outline, shadow, background box, position, per-word
 * highlighting — and it renders Cyrillic and Uzbek Latin correctly.
 */

// ---- cue model ----

/**
 * Word-level highlighting emits one ASS dialogue line per word and re-renders
 * the cue's whole word list inside each, so the file it produces grows as
 * (words on the cue) x (characters on the cue). These are bounds on input
 * rather than on rendering because the renderer must be free to trust what it
 * is handed.
 *
 * Counting words alone is not enough: 300 cues of 64 hundred-character words
 * are only 19,200 timings, yet they render to a 126 MB subtitle file. The
 * character budget below is the one that actually bounds the work; the count
 * caps are the cheap, legible first line.
 */
const MAX_WORD_CHARS = 100;
/**
 * Whisper emits one cue per spoken segment, up to ~30 s — around 75 words of
 * ordinary speech, and more when the speaker is fast. A cap near that number
 * would reject real transcripts (which are stored unvalidated by the
 * transcription job and then re-sent by the editor on every save), so this sits
 * far above human speech rather than close to it.
 */
const MAX_WORDS_PER_CUE = 250;
/** Per-cue alone still permits 5000 x 250; the track as a whole needs a ceiling too. */
const MAX_WORDS_PER_TRACK = 20_000;
/**
 * Characters of ASS the word-highlight renderer may be asked to emit for one
 * track. A 20,000-word transcript in ordinary cues costs ~7 M, so this leaves
 * real work untouched while capping the file at something libass and the worker
 * can hold.
 */
const MAX_HIGHLIGHT_CHARS = 12_000_000;
/** Timestamps, style fields and the colour tags wrapped around the lit word. */
const ASS_LINE_OVERHEAD = 64;

export const wordSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().max(MAX_WORD_CHARS),
});

export const cueSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().max(2000),
  /** Present only when the transcription provider returned word timings. */
  words: z.array(wordSchema).max(MAX_WORDS_PER_CUE).optional(),
});

export const cuesSchema = z
  .array(cueSchema)
  .max(5000)
  .superRefine((cues, ctx) => {
    let words = 0;
    let renderChars = 0;
    for (const cue of cues) {
      const onCue = cue.words?.length ?? 0;
      if (onCue === 0) continue;
      words += onCue;
      let chars = 0;
      for (const word of cue.words!) chars += word.text.length;
      renderChars += onCue * (chars + onCue + ASS_LINE_OVERHEAD);
    }

    if (words > MAX_WORDS_PER_TRACK) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "array",
        maximum: MAX_WORDS_PER_TRACK,
        inclusive: true,
        message: `This track carries ${words} word timings; at most ${MAX_WORDS_PER_TRACK} can be rendered.`,
      });
    }
    if (renderChars > MAX_HIGHLIGHT_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `These word timings would render to about ${Math.round(renderChars / 1_000_000)} MB of subtitle data; the limit is ${MAX_HIGHLIGHT_CHARS / 1_000_000} MB. Split the track, or shorten the words on its longest cues.`,
      });
    }
  });

export type SubtitleCue = z.infer<typeof cueSchema>;
export type SubtitleWord = z.infer<typeof wordSchema>;

/**
 * Normalise a cue list: drop empties, clamp negatives, sort, and repair
 * overlaps by trimming the earlier cue. Overlapping cues make ASS render two
 * lines on top of each other, which looks like a bug to the viewer.
 */
export function normalizeCues(cues: SubtitleCue[]): SubtitleCue[] {
  const cleaned = cues
    .map((c) => ({
      ...c,
      start: Math.max(0, c.start),
      end: Math.max(0, c.end),
      text: c.text.replace(/\s+/g, " ").trim(),
    }))
    .filter((c) => c.text.length > 0 && c.end > c.start)
    .sort((a, b) => a.start - b.start);

  for (let i = 0; i < cleaned.length - 1; i++) {
    const cur = cleaned[i];
    const next = cleaned[i + 1];
    if (!cur || !next || cur.end <= next.start) continue;
    if (next.start > cur.start) {
      cleaned[i] = { ...cur, end: next.start };
      continue;
    }
    /**
     * Two cues starting at the same instant. Trimming the earlier one to the
     * later one's start would give it zero length and the filter below would
     * DELETE it — losing a line of the transcript with nothing said. Nudge the
     * later cue instead so both survive; a hundredth of a second is below the
     * resolution ASS timestamps carry anyway.
     */
    const nudged = Math.min(next.end - 0.01, cur.start + 0.01);
    if (nudged > cur.start) {
      cleaned[i] = { ...cur, end: nudged };
      cleaned[i + 1] = { ...next, start: nudged };
    }
  }
  return cleaned.filter((c) => c.end > c.start);
}

/**
 * Split long cues so a line fits on a phone screen. Social captions are read in
 * motion; two short lines beat one long one.
 */
export function wrapCueText(text: string, maxCharsPerLine = 32, maxLines = 2): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if ((line + " " + w).length <= maxCharsPerLine) line += " " + w;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines.join("\n");
  // Too long for the allowance: rebalance into maxLines roughly-equal lines.
  const per = Math.ceil(text.length / maxLines);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > per && out.length < maxLines - 1) {
      out.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) out.push(cur);
  return out.join("\n");
}

/**
 * Re-time cues onto the rendered timeline.
 *
 * Captions are written against the SOURCE video, but they are burned into the
 * OUTPUT, which trimming and speed have already moved: FFmpeg applies `-ss` and
 * `setpts`, so output time is `(sourceTime - trimStart) / speed`. Without this
 * every trimmed or sped-up export shows its captions at the wrong moment — the
 * text is right and the timing is silently wrong, which is worse than no
 * captions at all. Cues that fall entirely outside the kept range are dropped.
 */
export function retimeCues(
  cues: SubtitleCue[],
  opts: { trimStartSec?: number; trimEndSec?: number; speed?: number },
): SubtitleCue[] {
  const start = Math.max(0, opts.trimStartSec ?? 0);
  const end = opts.trimEndSec;
  const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
  if (start === 0 && end === undefined && speed === 1) return cues;

  const map = (t: number) => (t - start) / speed;

  const out: SubtitleCue[] = [];
  for (const cue of cues) {
    if (end !== undefined && cue.start >= end) continue;
    if (cue.end <= start) continue;
    const clippedStart = Math.max(cue.start, start);
    const clippedEnd = end === undefined ? cue.end : Math.min(cue.end, end);
    if (clippedEnd <= clippedStart) continue;

    const words = cue.words
      ?.filter((w) => w.end > start && (end === undefined || w.start < end))
      .map((w) => ({
        start: Math.max(0, map(Math.max(w.start, start))),
        end: Math.max(0, map(end === undefined ? w.end : Math.min(w.end, end))),
        text: w.text,
      }))
      .filter((w) => w.end > w.start);

    out.push({
      start: Math.max(0, map(clippedStart)),
      end: Math.max(0, map(clippedEnd)),
      text: cue.text,
      ...(words && words.length > 0 ? { words } : {}),
    });
  }
  return out;
}

// ---- presets ----

/**
 * Ready-made looks. Each is a complete, renderable style — selecting one and
 * then adjusting any field is the intended workflow, so presets are just
 * starting values rather than a separate rendering path.
 */
export function applyPreset(preset: SubtitlePreset, over: Partial<SubtitleStyle> = {}): SubtitleStyle {
  return subtitleStyleSchema.parse({ ...SUBTITLE_PRESET_STYLES[preset], ...over, preset });
}

// ---- ASS generation ----

/** ASS colours are &HAABBGGRR — alpha first, then BGR, and alpha is inverted. */
function assColor(hex: string, opacity = 1): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  const rgb = m?.[1] ?? "FFFFFF";
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  const alpha = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `&H${alpha}${b}${g}${r}`.toUpperCase();
}

function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const cs = Math.floor((rest % 1) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(Math.floor(rest)).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/**
 * Escape text for an ASS dialogue line. Braces open override blocks and a
 * backslash starts an escape, so both must be neutralised; newlines become the
 * explicit ASS line break.
 */
function assEscape(text: string): string {
  return text
    .replace(/\\/g, "∖") // set minus — visually identical, inert in ASS
    .replace(/\{/g, "(")
    .replace(/\}/g, ")")
    .replace(/\r?\n/g, "\\N");
}

/**
 * How close to the frame edge "bottom" sits, as a percentage of frame height.
 *
 * ASS bottom-aligns "lower-center" and "bottom" identically (alignment 2), so
 * with one margin the two produced the SAME style line: a four-option control
 * with three outcomes, where an operator who picked "bottom" saw the caption
 * not move. "lower-center" is the social caption band, lifted clear of the
 * edge; "bottom" is a broadcast subtitle sitting against it. An operator who
 * has already asked for a smaller margin than this keeps theirs.
 */
const BOTTOM_EDGE_MARGIN_PCT = 3;

/** ASS numeric alignment (numpad layout). */
function alignmentCode(style: SubtitleStyle): number {
  const horizontal = style.alignment === "left" ? 1 : style.alignment === "right" ? 3 : 2;
  if (style.position === "top") return horizontal + 6; // 7,8,9
  if (style.position === "middle") return horizontal + 3; // 4,5,6
  return horizontal; // 1,2,3 — bottom row
}

export interface AssOptions {
  width: number;
  height: number;
  style: SubtitleStyle;
  maxCharsPerLine?: number;
}

/**
 * Build a complete ASS subtitle file.
 *
 * Sizes are expressed as a percentage of frame height in our model and resolved
 * to pixels here, so a style looks the same on a 720p preview and a 1080p
 * export rather than shrinking on the larger frame.
 */
export function buildAssFile(cues: SubtitleCue[], opts: AssOptions): string {
  const { width, height, style } = opts;
  const fontPx = Math.max(12, Math.round((style.fontSizePct / 100) * height));
  const marginPct =
    style.position === "bottom" ? Math.min(style.marginVerticalPct, BOTTOM_EDGE_MARGIN_PCT) : style.marginVerticalPct;
  const marginV = Math.round((marginPct / 100) * height);
  const marginH = Math.round(width * 0.06);

  // BorderStyle 3 draws an opaque box behind the text; 1 draws outline+shadow.
  const useBox = style.backgroundOpacity > 0.01;
  const borderStyle = useBox ? 3 : 1;
  const outline = useBox ? Math.max(2, Math.round(fontPx * 0.18)) : style.outlineWidth;

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    `PlayResX: ${Math.round(width)}`,
    `PlayResY: ${Math.round(height)}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    [
      "Style: Default",
      sanitizeFontName(style.fontFamily),
      String(fontPx),
      assColor(style.textColor),
      assColor(style.wordHighlightColor),
      assColor(style.outlineColor),
      assColor(style.backgroundColor, style.backgroundOpacity),
      style.bold ? "-1" : "0",
      style.italic ? "-1" : "0",
      "0",
      "0",
      "100",
      "100",
      String(Math.round(style.lineSpacing)),
      "0",
      String(borderStyle),
      String(outline),
      String(style.shadow),
      String(alignmentCode(style)),
      String(marginH),
      String(marginH),
      String(marginV),
      "1",
    ].join(","),
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const maxChars = opts.maxCharsPerLine ?? Math.max(18, Math.round(width / (fontPx * 0.58)));
  const lines: string[] = [];

  for (const cue of normalizeCues(cues)) {
    const canHighlight = style.wordHighlight && Array.isArray(cue.words) && cue.words.length > 0;
    if (canHighlight) {
      lines.push(...wordHighlightEvents(cue, style, maxChars));
    } else {
      const text = style.uppercase ? cue.text.toLocaleUpperCase() : cue.text;
      lines.push(
        `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${assEscape(wrapCueText(text, maxChars))}`,
      );
    }
  }

  return [...header, ...lines, ""].join("\n");
}

/**
 * Per-word highlighting: one dialogue event per word window, with that word
 * recoloured inline. Only reachable when the provider gave real word timings —
 * the caller checks, because inventing timings would desynchronise visibly.
 */
function wordHighlightEvents(cue: SubtitleCue, style: SubtitleStyle, maxChars: number): string[] {
  const words = (cue.words ?? []).filter((w) => w.text.trim().length > 0);
  if (words.length === 0) return [];
  const highlight = assColor(style.wordHighlightColor);
  const normal = assColor(style.textColor);
  const out: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word) continue;
    const start = Math.max(cue.start, word.start);
    const next = words[i + 1];
    const end = next ? Math.max(start, Math.min(next.start, cue.end)) : cue.end;
    if (end <= start) continue;

    const rendered = words
      .map((w, j) => {
        const t = assEscape(style.uppercase ? w.text.toLocaleUpperCase() : w.text);
        return j === i ? `{\\c${highlight}}${t}{\\c${normal}}` : t;
      })
      .join(" ");

    // Wrapping is applied to the plain text to decide breaks, then the same
    // break positions are honoured in the marked-up string.
    const plain = words.map((w) => (style.uppercase ? w.text.toLocaleUpperCase() : w.text)).join(" ");
    const needsWrap = plain.length > maxChars;
    const text = needsWrap ? insertBreaks(rendered, plain, maxChars) : rendered;

    out.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${text}`);
  }
  return out;
}

/** Mirror the line breaks chosen for `plain` into the marked-up string. */
function insertBreaks(marked: string, plain: string, maxChars: number): string {
  const wrapped = wrapCueText(plain, maxChars);
  const breakAfter = new Set<number>();
  let count = 0;
  // Every line BUT THE LAST earns a break after its final word. Including the
  // last one appends a trailing `\N`, which libass renders as an empty line
  // below the caption — lifting a wrapped, word-highlighted cue one line off
  // the margin the operator set while an unwrapped one stays put, so the text
  // jumps as the captions change.
  for (const line of wrapped.split("\n").slice(0, -1)) {
    count += line.split(" ").length;
    breakAfter.add(count - 1);
  }
  let idx = -1;
  return marked
    .split(" ")
    .map((tok) => {
      // Count only tokens that carry visible text, so colour tags do not shift indices.
      if (/[^\s{}\\]/.test(tok.replace(/\{[^}]*\}/g, ""))) idx++;
      return breakAfter.has(idx) ? tok + "\\N" : tok;
    })
    .join(" ")
    .replace(/\\N /g, "\\N");
}

/** Font names appear in a comma-separated ASS field; commas would break it. */
function sanitizeFontName(name: string): string {
  return name.replace(/[,\r\n]/g, " ").trim().slice(0, 64) || "DejaVu Sans";
}

// ---- SRT / VTT export ----

function srtTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = s % 60;
  const ms = Math.round((rest % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(Math.floor(rest)).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

export function buildSrtFile(cues: SubtitleCue[]): string {
  return (
    normalizeCues(cues)
      .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${wrapCueText(c.text)}\n`)
      .join("\n") + "\n"
  );
}

export function buildVttFile(cues: SubtitleCue[]): string {
  const body = normalizeCues(cues)
    .map((c) => `${srtTime(c.start).replace(",", ".")} --> ${srtTime(c.end).replace(",", ".")}\n${wrapCueText(c.text)}\n`)
    .join("\n");
  return `WEBVTT\n\n${body}`;
}

// ---- SRT import ----

/** Parse an uploaded SRT/VTT file. Tolerant of both time separators and BOM. */
export function parseSubtitleFile(content: string): SubtitleCue[] {
  const text = content.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const blocks = text.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    const timeLine = lines.find((l) => l.includes("-->"));
    if (!timeLine) continue;
    const m = /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/.exec(timeLine);
    if (!m) continue;
    const g = m as unknown as string[];
    const toSec = (h: string, mi: string, s: string, ms: string) =>
      Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
    const start = toSec(g[1]!, g[2]!, g[3]!, g[4]!);
    const end = toSec(g[5]!, g[6]!, g[7]!, g[8]!);
    const body = lines.slice(lines.indexOf(timeLine) + 1).join("\n").trim();
    if (body) cues.push({ start, end, text: body });
  }
  return normalizeCues(cues);
}
