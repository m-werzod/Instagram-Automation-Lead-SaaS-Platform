import { describe, expect, it } from "vitest";
import {
  buildContainerParams,
  describePublishError,
  extensionFor,
  hostedMediaUrl,
  isJpeg,
  kindFromUrl,
  parseContainerStatus,
  parsePublishingLimit,
  validatePublishInput,
} from "@/lib/meta/publishing";
import { MetaApiError } from "@/lib/meta/client";

/**
 * Publishing maps onto Meta's container → status → media_publish protocol.
 * The pure parts are pinned here: what we refuse before calling Meta, the exact
 * container parameters per media type, and how Meta's answers are read.
 */

const img = { url: "https://cdn.example.com/a.jpg", kind: "IMAGE" as const };
const vid = { url: "https://cdn.example.com/a.mp4", kind: "VIDEO" as const };

describe("validatePublishInput", () => {
  it("accepts a plain photo post", () => {
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], caption: "hi" })).toBeNull();
  });
  it("requires the right media kind per type", () => {
    expect(validatePublishInput({ mediaType: "IMAGE", items: [vid] })).toMatch(/image/);
    expect(validatePublishInput({ mediaType: "REELS", items: [img] })).toMatch(/video/);
    expect(validatePublishInput({ mediaType: "STORIES", items: [img] })).toBeNull();
    expect(validatePublishInput({ mediaType: "STORIES", items: [vid] })).toBeNull();
  });
  it("enforces carousel size 2–10 and one item otherwise", () => {
    expect(validatePublishInput({ mediaType: "CAROUSEL", items: [img] })).toMatch(/2–10/);
    expect(validatePublishInput({ mediaType: "CAROUSEL", items: Array(11).fill(img) })).toMatch(/2–10/);
    expect(validatePublishInput({ mediaType: "CAROUSEL", items: [img, vid] })).toBeNull();
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img, img] })).toMatch(/Exactly one/);
  });
  it("refuses non-https media and over-long captions", () => {
    expect(validatePublishInput({ mediaType: "IMAGE", items: [{ url: "http://x/a.jpg", kind: "IMAGE" }] })).toMatch(/https/);
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], caption: "x".repeat(2201) })).toMatch(/2200/);
  });
  it("bounds the schedule window", () => {
    const now = new Date("2026-09-12T12:00:00Z");
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], scheduledAt: new Date("2026-09-12T11:00:00Z"), now })).toMatch(/past/);
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], scheduledAt: new Date("2026-12-31T11:00:00Z"), now })).toMatch(/75 days/);
    expect(validatePublishInput({ mediaType: "IMAGE", items: [img], scheduledAt: new Date("2026-09-13T11:00:00Z"), now })).toBeNull();
  });
});

describe("buildContainerParams", () => {
  it("photo: image_url + caption, no children", () => {
    const p = buildContainerParams({ mediaType: "IMAGE", items: [img], caption: " Hello " });
    expect(p.children).toEqual([]);
    expect(p.main([])).toEqual({ image_url: img.url, caption: "Hello" });
  });
  it("reel: media_type REELS, video_url, share_to_feed and cover", () => {
    const p = buildContainerParams({ mediaType: "REELS", items: [vid], caption: "c", shareToFeed: false, coverUrl: "https://cdn/c.jpg" });
    expect(p.main([])).toEqual({ media_type: "REELS", video_url: vid.url, caption: "c", share_to_feed: false, cover_url: "https://cdn/c.jpg" });
  });
  it("story: STORIES with the matching url field and never a caption", () => {
    expect(buildContainerParams({ mediaType: "STORIES", items: [img], caption: "ignored" }).main([])).toEqual({ media_type: "STORIES", image_url: img.url });
    expect(buildContainerParams({ mediaType: "STORIES", items: [vid] }).main([])).toEqual({ media_type: "STORIES", video_url: vid.url });
  });
  it("carousel: children flagged is_carousel_item, parent lists their ids", () => {
    const p = buildContainerParams({ mediaType: "CAROUSEL", items: [img, vid], caption: "album" });
    expect(p.children).toEqual([
      { is_carousel_item: true, image_url: img.url },
      { is_carousel_item: true, media_type: "VIDEO", video_url: vid.url },
    ]);
    expect(p.main(["1", "2"])).toEqual({ media_type: "CAROUSEL", children: "1,2", caption: "album" });
  });
});

describe("reading Meta's answers", () => {
  it("maps status_code values and keeps the human status line", () => {
    expect(parseContainerStatus({ status_code: "FINISHED" })).toEqual({ code: "FINISHED", message: null });
    expect(parseContainerStatus({ status_code: "ERROR", status: "Error: Media aspect ratio invalid" })).toEqual({
      code: "ERROR",
      message: "Error: Media aspect ratio invalid",
    });
    expect(parseContainerStatus({}).code).toBe("UNKNOWN");
  });
  it("reads the publishing quota, defaulting the total to Meta's 100", () => {
    expect(parsePublishingLimit({ data: [{ quota_usage: 7, config: { quota_total: 100 } }] })).toEqual({ used: 7, quota: 100 });
    expect(parsePublishingLimit({ data: [{ quota_usage: 3 }] })).toEqual({ used: 3, quota: 100 });
    expect(parsePublishingLimit({ data: [] })).toBeNull();
  });
  it("explains a Meta error in one admin-readable line", () => {
    const err = new MetaApiError({ message: "Invalid parameter", code: 100, error_user_msg: "The video format is not supported." }, 400);
    expect(describePublishError(err)).toMatch(/video format is not supported/);
    expect(describePublishError(new Error("boom"))).toBe("boom");
  });
});

describe("hosted media", () => {
  it("builds a public URL with the extension Meta expects", () => {
    expect(hostedMediaUrl("abc123", "image/jpeg")).toBe("http://localhost:3000/m/abc123.jpg");
    expect(extensionFor("video/mp4")).toBe("mp4");
    expect(extensionFor("image/png")).toBe("bin");
  });
  it("recognises JPEG by signature, not by name", () => {
    expect(isJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe(true);
    expect(isJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false); // PNG
  });
  it("infers the kind of a pasted URL from its extension", () => {
    expect(kindFromUrl("https://x/clip.MP4?token=1")).toBe("VIDEO");
    expect(kindFromUrl("https://x/photo.jpg")).toBe("IMAGE");
  });
});
