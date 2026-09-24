import { describe, it, expect } from "vitest";
import {
  applyEditPatch,
  defaultEditParams,
  diffEditParams,
  editParamsSchema,
  checkExportForInstagram,
  subtitleStyleSchema,
} from "@/lib/video/params";

/**
 * The edit model is the boundary between "what the AI said" and "what FFmpeg
 * runs". These tests pin that boundary: anything out of range, unknown, or
 * shaped like an injection must fail validation rather than reach the encoder.
 */

describe("edit parameters", () => {
  it("defaults are valid and neutral", () => {
    const p = defaultEditParams();
    expect(editParamsSchema.safeParse(p).success).toBe(true);
    expect(p.audio.originalVolume).toBe(100);
    expect(p.video.speed).toBe(1);
    expect(p.audio.tracks).toEqual([]);
  });

  it("keeps the original and uploaded volumes independent", () => {
    // The product's core promise: "original 30%, music 100%" is two numbers.
    const p = applyEditPatch(defaultEditParams(), {
      audio: { originalVolume: 30, tracks: [{ assetId: "a1", volume: 100 }] },
    });
    expect(p.audio.originalVolume).toBe(30);
    expect(p.audio.tracks[0]?.volume).toBe(100);
  });

  it("preserves untouched sections when a patch changes one field", () => {
    const base = applyEditPatch(defaultEditParams(), { video: { speed: 1.5 }, look: { preset: "vivid" } });
    const next = applyEditPatch(base, { audio: { originalVolume: 10 } });
    expect(next.video.speed).toBe(1.5);
    expect(next.look.preset).toBe("vivid");
    expect(next.audio.originalVolume).toBe(10);
  });

  it.each([
    ["negative volume", { audio: { originalVolume: -50 } }],
    ["volume above the cap", { audio: { originalVolume: 5000 } }],
    ["speed beyond the range", { video: { speed: 100 } }],
    ["unknown aspect ratio", { video: { aspect: "banana" } }],
    ["unknown colour preset", { look: { preset: "cinematic-blockbuster" } }],
    ["colour that is not a hex value", { subtitles: { style: { textColor: "red; rm -rf /" } } }],
    ["shell-shaped pad colour", { video: { padColor: "$(whoami)" } }],
    ["negative trim", { video: { trim: { startSec: -5 } } }],
  ])("rejects %s", (_label, patch) => {
    expect(() => applyEditPatch(defaultEditParams(), patch)).toThrow();
  });

  it("rejects a trim whose end precedes its start", () => {
    expect(() => applyEditPatch(defaultEditParams(), { video: { trim: { startSec: 10, endSec: 5 } } })).toThrow();
  });

  it("produces a readable diff for the confirmation step", () => {
    const base = defaultEditParams();
    const next = applyEditPatch(base, { audio: { originalVolume: 30 } });
    const changes = diffEditParams(base, next);
    expect(changes).toContainEqual({ path: "audio.originalVolume", from: "100", to: "30" });
  });

  it("reports no diff when nothing actually changed", () => {
    const base = defaultEditParams();
    expect(diffEditParams(base, applyEditPatch(base, {}))).toEqual([]);
  });

  it("clamps subtitle styling to renderable values", () => {
    expect(subtitleStyleSchema.safeParse({ fontSizePct: 900 }).success).toBe(false);
    expect(subtitleStyleSchema.safeParse({ backgroundOpacity: 5 }).success).toBe(false);
    expect(subtitleStyleSchema.safeParse({ position: "diagonal" }).success).toBe(false);
    expect(subtitleStyleSchema.safeParse({ preset: "clean-white", fontSizePct: 6 }).success).toBe(true);
  });
});

describe("Instagram export checks", () => {
  it("flags a Reel that is too long", () => {
    const warnings = checkExportForInstagram({ durationSec: 1200, width: 1080, height: 1920, sizeBytes: 5e6, target: "REELS" });
    expect(warnings.map((w) => w.code)).toContain("REEL_TOO_LONG");
  });

  it("flags a non-vertical Reel", () => {
    const warnings = checkExportForInstagram({ durationSec: 30, width: 1920, height: 1080, sizeBytes: 5e6, target: "REELS" });
    expect(warnings.map((w) => w.code)).toContain("ASPECT_NOT_VERTICAL");
  });

  it("flags a Story over the 60s limit", () => {
    const warnings = checkExportForInstagram({ durationSec: 90, width: 1080, height: 1920, sizeBytes: 5e6, target: "STORIES" });
    expect(warnings.map((w) => w.code)).toContain("STORY_TOO_LONG");
  });

  it("passes a compliant vertical Reel without inventing problems", () => {
    const warnings = checkExportForInstagram({ durationSec: 25, width: 1080, height: 1920, sizeBytes: 12e6, target: "REELS" });
    expect(warnings).toEqual([]);
  });

  it("does not guess when dimensions are unknown", () => {
    const warnings = checkExportForInstagram({ durationSec: null, width: null, height: null, sizeBytes: 1e6, target: "REELS" });
    expect(warnings).toEqual([]);
  });
});
