import { describe, it, expect } from "vitest";
import {
  buildAssFile,
  buildSrtFile,
  buildVttFile,
  parseSubtitleFile,
  normalizeCues,
  wrapCueText,
  applyPreset,
  SUBTITLE_PRESET_STYLES,
  type SubtitleCue,
} from "@/lib/video/subtitles";
import { subtitleStyleSchema, SUBTITLE_PRESETS } from "@/lib/video/params";

const style = subtitleStyleSchema.parse({});

describe("cue normalisation", () => {
  it("sorts, trims and drops empty cues", () => {
    const out = normalizeCues([
      { start: 5, end: 7, text: "  second  " },
      { start: 1, end: 3, text: "first" },
      { start: 8, end: 9, text: "   " },
      { start: 10, end: 10, text: "zero length" },
    ]);
    expect(out.map((c) => c.text)).toEqual(["first", "second"]);
  });

  it("repairs overlapping cues so two lines never stack", () => {
    const out = normalizeCues([
      { start: 0, end: 5, text: "a" },
      { start: 3, end: 6, text: "b" },
    ]);
    expect(out[0]?.end).toBe(3);
  });

  it("wraps long lines for a phone screen", () => {
    const wrapped = wrapCueText("one two three four five six seven eight nine ten eleven twelve", 20, 2);
    expect(wrapped.split("\n").length).toBeLessThanOrEqual(2);
  });
});

describe("ASS generation", () => {
  const cues: SubtitleCue[] = [
    { start: 0.5, end: 2, text: "Salom dunyo" },
    { start: 2.1, end: 4, text: "Привет мир" },
  ];

  it("writes a complete, well-formed ASS file", () => {
    const ass = buildAssFile(cues, { width: 1080, height: 1920, style });
    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("[V4+ Styles]");
    expect(ass).toContain("[Events]");
    expect(ass).toContain("PlayResX: 1080");
    expect(ass.match(/^Dialogue: /gm)?.length).toBe(2);
  });

  it("keeps Uzbek and Cyrillic characters intact", () => {
    const ass = buildAssFile([{ start: 0, end: 1, text: "oʻzbek gʻalaba — Привет" }], { width: 720, height: 1280, style });
    expect(ass).toContain("oʻzbek gʻalaba");
    expect(ass).toContain("Привет");
  });

  it("neutralises text that would otherwise be ASS markup", () => {
    // Braces open an override block and a backslash starts an escape; neither
    // may survive into a dialogue line, or caption text could restyle the video.
    const ass = buildAssFile([{ start: 0, end: 1, text: "{\\an8}{\\c&HFF0000&}hack C:\\evil" }], {
      width: 720,
      height: 1280,
      style,
    });
    const dialogue = ass.split("\n").find((l) => l.startsWith("Dialogue:")) ?? "";
    expect(dialogue).not.toContain("{\\an8}");
    expect(dialogue).not.toContain("{\\c&HFF0000&}");
    expect(dialogue).toContain("hack");
  });

  it("scales text with the frame so a preset looks the same at any size", () => {
    const small = buildAssFile(cues, { width: 720, height: 1280, style });
    const large = buildAssFile(cues, { width: 1080, height: 1920, style });
    const size = (s: string) => Number(s.split("\n").find((l) => l.startsWith("Style: Default"))?.split(",")[2]);
    expect(size(large)).toBeGreaterThan(size(small));
  });

  it("converts colours to the ASS BGR form with inverted alpha", () => {
    const red = subtitleStyleSchema.parse({ textColor: "#FF0000", backgroundOpacity: 0 });
    const ass = buildAssFile(cues, { width: 720, height: 1280, style: red });
    // #FF0000 -> &H00 0000 FF (opaque, blue-green-red order)
    expect(ass).toContain("&H000000FF");
  });

  it("emits per-word events only when word timings exist", () => {
    const withWords = subtitleStyleSchema.parse({ wordHighlight: true });
    const timed: SubtitleCue[] = [
      {
        start: 0,
        end: 2,
        text: "one two three",
        words: [
          { start: 0, end: 0.6, text: "one" },
          { start: 0.6, end: 1.2, text: "two" },
          { start: 1.2, end: 2, text: "three" },
        ],
      },
    ];
    const highlighted = buildAssFile(timed, { width: 720, height: 1280, style: withWords });
    expect(highlighted.match(/^Dialogue: /gm)?.length).toBe(3);

    // Without timings it must fall back to one line, not invent a rhythm.
    const untimed = buildAssFile([{ start: 0, end: 2, text: "one two three" }], { width: 720, height: 1280, style: withWords });
    expect(untimed.match(/^Dialogue: /gm)?.length).toBe(1);
  });

  it("uppercases only when the style asks", () => {
    const upper = subtitleStyleSchema.parse({ uppercase: true });
    expect(buildAssFile([{ start: 0, end: 1, text: "quiet" }], { width: 720, height: 1280, style: upper })).toContain("QUIET");
    expect(buildAssFile([{ start: 0, end: 1, text: "quiet" }], { width: 720, height: 1280, style })).toContain("quiet");
  });
});

describe("presets", () => {
  it("every named preset produces a valid, renderable style", () => {
    for (const preset of SUBTITLE_PRESETS) {
      const parsed = applyPreset(preset);
      expect(parsed.preset).toBe(preset);
      expect(subtitleStyleSchema.safeParse(parsed).success).toBe(true);
      expect(() => buildAssFile([{ start: 0, end: 1, text: "test" }], { width: 1080, height: 1920, style: parsed })).not.toThrow();
    }
  });

  it("covers every preset the parameter schema advertises", () => {
    expect(Object.keys(SUBTITLE_PRESET_STYLES).sort()).toEqual([...SUBTITLE_PRESETS].sort());
  });

  it("only the highlighted-words preset turns word highlighting on", () => {
    expect(applyPreset("highlighted-words").wordHighlight).toBe(true);
    expect(applyPreset("clean-white").wordHighlight).toBe(false);
  });

  it("lets a customisation override the preset it started from", () => {
    expect(applyPreset("minimal", { fontSizePct: 10 }).fontSizePct).toBe(10);
  });
});

describe("SRT and VTT", () => {
  const cues: SubtitleCue[] = [
    { start: 0, end: 1.5, text: "first line" },
    { start: 2, end: 3.25, text: "ikkinchi qator" },
  ];

  it("round-trips through SRT without losing cues", () => {
    const parsed = parseSubtitleFile(buildSrtFile(cues));
    expect(parsed.length).toBe(2);
    expect(parsed[1]?.text).toBe("ikkinchi qator");
    expect(parsed[0]?.end).toBeCloseTo(1.5, 2);
  });

  it("writes WebVTT with a header and dot separators", () => {
    const vtt = buildVttFile(cues);
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.500");
  });

  it("reads an imported file with either separator, CRLF endings and a BOM", () => {
    const srt = "\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n\r\n2\r\n00:00:03.000 --> 00:00:04.000\r\nWorld\r\n";
    const parsed = parseSubtitleFile(srt);
    expect(parsed.map((c) => c.text)).toEqual(["Hello", "World"]);
  });

  it("ignores junk instead of throwing", () => {
    expect(parseSubtitleFile("not a subtitle file at all")).toEqual([]);
    expect(parseSubtitleFile("")).toEqual([]);
  });
});
