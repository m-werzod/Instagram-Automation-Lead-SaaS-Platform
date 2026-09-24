import { describe, expect, it } from "vitest";
import { DICTIONARIES } from "@/lib/i18n/dictionaries";
import { cueRefreshAction } from "@/app/(dashboard)/video-editor/[id]/tabs-subtitles";
import { isPreviewStale, lastEditAt, previewRenderedAt } from "@/app/(dashboard)/video-editor/[id]/jobs-panel";
import { uploadMimeType } from "@/app/(dashboard)/video-editor/[id]/upload-drop";
import type { VideoJobRow } from "@/app/(dashboard)/video-editor/[id]/types";

/**
 * Editor client rules that decide whether the operator is told the truth:
 * whether their typing survives a background poll, whether a preview is
 * presented as current, and whether an upload describes itself consistently.
 */

describe("cue editor refresh", () => {
  const base = { loadedTrackId: "t1", incomingTrackId: "t1", serverChanged: false, dirty: false };

  it("does nothing when a poll returns the same cues", () => {
    expect(cueRefreshAction(base)).toBe("none");
    expect(cueRefreshAction({ ...base, dirty: true })).toBe("none");
  });

  it("never discards unsaved edits when the server copy moved", () => {
    expect(cueRefreshAction({ ...base, serverChanged: true, dirty: true })).toBe("conflict");
  });

  it("adopts the server copy when there is nothing unsaved to lose", () => {
    expect(cueRefreshAction({ ...base, serverChanged: true })).toBe("adopt");
  });

  it("adopts on a track switch, which is an explicit choice", () => {
    expect(cueRefreshAction({ ...base, incomingTrackId: "t2", dirty: true })).toBe("adopt");
    expect(cueRefreshAction({ ...base, loadedTrackId: undefined, incomingTrackId: "t1" })).toBe("adopt");
  });
});

describe("preview freshness", () => {
  const job = (over: Partial<VideoJobRow>): VideoJobRow => ({
    id: "j1",
    kind: "PREVIEW",
    status: "DONE",
    progressPct: 100,
    error: null,
    logTail: null,
    outputAssetId: "a1",
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-01-01T10:00:00.000Z",
    ...over,
  });

  it("claims nothing without a usable project timestamp", () => {
    expect(isPreviewStale("2026-01-01T10:00:00.000Z", undefined)).toBe(false);
    expect(isPreviewStale("2026-01-01T10:00:00.000Z", "not a date")).toBe(false);
  });

  it("flags a preview rendered before the last edit", () => {
    expect(isPreviewStale("2026-01-01T10:00:00.000Z", "2026-01-01T10:05:00.000Z")).toBe(true);
    expect(isPreviewStale("2026-01-01T10:05:00.000Z", "2026-01-01T10:00:00.000Z")).toBe(false);
  });

  it("dates a preview from the job that rendered it, not from the file it wrote", () => {
    const jobs = [job({ startedAt: "2026-01-01T10:00:00.000Z" })];
    // The asset lands when FFmpeg finishes; an edit made mid-render is older
    // than that file yet still invalidates it.
    const renderedAt = previewRenderedAt("a1", "2026-01-01T10:09:00.000Z", jobs);
    expect(renderedAt).toBe("2026-01-01T10:00:00.000Z");
    expect(isPreviewStale(renderedAt, "2026-01-01T10:03:00.000Z")).toBe(true);
  });

  it("falls back to the asset when its job has scrolled out of the list", () => {
    expect(previewRenderedAt("a1", "2026-01-01T10:09:00.000Z", [])).toBe("2026-01-01T10:09:00.000Z");
    expect(previewRenderedAt("a1", "2026-01-01T10:09:00.000Z", [job({ outputAssetId: "other" })])).toBe(
      "2026-01-01T10:09:00.000Z",
    );
  });

  it("uses the job's creation time while it has not started yet", () => {
    expect(previewRenderedAt("a1", "2026-01-01T10:09:00.000Z", [job({ startedAt: null })])).toBe(
      "2026-01-01T10:00:00.000Z",
    );
  });

  it("counts a subtitle save as an edit — it never touches the project row", () => {
    const rendered = "2026-01-01T10:00:00.000Z";
    const projectUpdated = "2026-01-01T09:55:00.000Z";
    const cuesSaved = "2026-01-01T10:06:00.000Z";
    expect(isPreviewStale(rendered, lastEditAt(projectUpdated))).toBe(false);
    expect(isPreviewStale(rendered, lastEditAt(projectUpdated, cuesSaved))).toBe(true);
  });

  it("ignores missing and unparsable timestamps rather than treating them as now", () => {
    expect(lastEditAt(undefined, null)).toBeUndefined();
    expect(lastEditAt("2026-01-01T10:00:00.000Z", "not a date")).toBe("2026-01-01T10:00:00.000Z");
    expect(lastEditAt("not a date")).toBeUndefined();
    expect(lastEditAt("2026-01-01T10:00:00.000Z", "2026-01-01T11:00:00.000Z")).toBe("2026-01-01T11:00:00.000Z");
  });
});

describe("upload MIME agreement", () => {
  it("keeps the browser's own type", () => {
    expect(uploadMimeType("clip.mov", "video/quicktime", "SOURCE")).toBe("video/quicktime");
  });

  it("drops parameters so the reserve step and the upload header match exactly", () => {
    expect(uploadMimeType("clip.mp4", "video/mp4; codecs=avc1", "SOURCE")).toBe("video/mp4");
  });

  it("guesses once by extension when the browser reports nothing", () => {
    expect(uploadMimeType("clip.mkv", "", "SOURCE")).toBe("video/x-matroska");
    expect(uploadMimeType("voice.m4a", "", "AUDIO")).toBe("audio/mp4");
    expect(uploadMimeType("clip.mkv", "   ", "SAMPLE")).toBe("video/x-matroska");
  });
});

describe("editor dictionaries", () => {
  const paths = (value: unknown, prefix = ""): string[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [prefix];
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      paths(v, prefix ? `${prefix}.${k}` : k),
    );
  };

  it("keeps all three locales in exact key parity", () => {
    const en = paths(DICTIONARIES.en).sort();
    for (const locale of ["uz", "ru"] as const) {
      expect({ locale, keys: paths(DICTIONARIES[locale]).sort() }).toEqual({ locale, keys: en });
    }
  });

  it("labels subtitle positions and colour looks instead of showing code slugs", () => {
    for (const locale of ["en", "uz", "ru"] as const) {
      const d = DICTIONARIES[locale].videoEditor;
      for (const position of ["top", "middle", "lower-center", "bottom"] as const) {
        const label = d.subtitlesPanel.positions[position];
        expect(label.length, `${locale}.${position}`).toBeGreaterThan(0);
        expect(label, `${locale}.${position}`).not.toBe(position);
      }
      for (const look of ["none", "vivid", "warm", "cool", "soft", "contrast", "bw"] as const) {
        const label = d.video.looks[look];
        expect(label.length, `${locale}.${look}`).toBeGreaterThan(0);
        expect(label, `${locale}.${look}`).not.toBe(look);
      }
    }
  });

  it("has wording for queued work and for a source that failed its check", () => {
    for (const locale of ["en", "uz", "ru"] as const) {
      const d = DICTIONARIES[locale].videoEditor;
      expect(d.jobs.queuedToast.length).toBeGreaterThan(0);
      expect(d.jobs.queuedHint.length).toBeGreaterThan(0);
      expect(d.sourceFailed.title.length).toBeGreaterThan(0);
      // The failed-source state must offer a way out, not just describe itself.
      expect(d.sourceFailed.canReplace.length).toBeGreaterThan(0);
      expect(d.sourceFailed.removeAndRetry.length).toBeGreaterThan(0);
      expect(d.sourceFailed.removing.length).toBeGreaterThan(0);
      expect(d.samplePanel.retry.length).toBeGreaterThan(0);
      expect(d.subtitlesPanel.unsavedCues.length).toBeGreaterThan(0);
    }
  });
});
