import { describe, it, expect } from "vitest";
import { buildRenderArgs, atempoChain, resolveTargetSize, effectiveDuration, escapeFilterPath, buildAudioExtractArgs, buildThumbnailArgs } from "@/lib/video/render";
import { applyEditPatch, defaultEditParams } from "@/lib/video/params";

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
