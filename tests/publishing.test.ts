import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildContainerParams,
  describePublishError,
  extensionFor,
  hostedMediaUrl,
  isJpeg,
  kindFromUrl,
  kindFromUrlOrNull,
  parseContainerStatus,
  parsePublishingLimit,
  publishRunKey,
  PUBLISH_QUOTA_ERROR_CODE,
  QUOTA_RETRY_DELAY_MS,
  RATE_LIMIT_RETRY_DELAY_MS,
  resolveItemKind,
  retryDelayForPublishError,
  scheduleKey,
  validatePublishInput,
  wakeKey,
  wakeRunAt,
} from "@/lib/meta/publishing";
import { insightMetricsFor } from "@/lib/meta/media";
import { contentDispositionFor } from "@/lib/resources";
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

describe("resolveItemKind", () => {
  const signed = "https://cdn.example.com/assets/9f2b?Expires=1&Signature=abc"; // no extension at all

  it("fills a format-less URL in from the media type, where only one kind is legal", () => {
    expect(resolveItemKind("REELS", signed)).toBe("VIDEO");
    expect(resolveItemKind("IMAGE", signed)).toBe("IMAGE");
    // the extension heuristic alone called the signed URL an image and made the Reel unpublishable
    expect(kindFromUrl(signed)).toBe("IMAGE");
  });

  it("honours an explicit kind where both are legal, and guesses only as a last resort", () => {
    expect(resolveItemKind("STORIES", signed, "VIDEO")).toBe("VIDEO");
    expect(resolveItemKind("CAROUSEL", signed, "VIDEO")).toBe("VIDEO");
    expect(resolveItemKind("STORIES", signed)).toBe("IMAGE");
    expect(resolveItemKind("CAROUSEL", "https://x/a.mov")).toBe("VIDEO");
  });

  it("ignores a caller's kind where the media type already settles it", () => {
    expect(resolveItemKind("REELS", signed, "IMAGE")).toBe("VIDEO");
    expect(resolveItemKind("IMAGE", signed, "VIDEO")).toBe("IMAGE");
  });

  it("keeps a URL that names a contradicting format, so the mismatch is refused here", () => {
    // coercing these to the chosen type queued a post that could only die at
    // Meta — the admin got a success toast for a publication that cannot work
    expect(resolveItemKind("IMAGE", "https://x/a.mp4", "VIDEO")).toBe("VIDEO");
    expect(resolveItemKind("REELS", "https://x/a.jpg")).toBe("IMAGE");
    expect(validatePublishInput({ mediaType: "IMAGE", items: [{ url: "https://x/a.mp4", kind: resolveItemKind("IMAGE", "https://x/a.mp4") }] })).toMatch(/image/);
    expect(validatePublishInput({ mediaType: "REELS", items: [{ url: "https://x/a.jpg", kind: resolveItemKind("REELS", "https://x/a.jpg") }] })).toMatch(/video/);
  });

  it("reads a format only from a real extension, never from the host name", () => {
    expect(kindFromUrlOrNull(signed)).toBeNull();
    expect(kindFromUrlOrNull("https://cdn.example.com")).toBeNull();
    expect(kindFromUrlOrNull("https://x/a.bin")).toBeNull();
    expect(kindFromUrlOrNull("https://x/clip.MOV?sig=1")).toBe("VIDEO");
    expect(kindFromUrlOrNull("https://x/photo.webp#frag")).toBe("IMAGE");
  });

  it("only ever produces a kind validatePublishInput then accepts", () => {
    // the two disagreed: the resolver's caller wrote IMAGE for a signed video
    // link and the validator rejected the Reel the admin had explicitly chosen
    for (const mediaType of ["IMAGE", "REELS", "STORIES"] as const) {
      expect(validatePublishInput({ mediaType, items: [{ url: signed, kind: resolveItemKind(mediaType, signed) }] })).toBeNull();
    }
    const carousel = [signed, "https://x/a.mp4"].map((url) => ({ url, kind: resolveItemKind("CAROUSEL", url) }));
    expect(validatePublishInput({ mediaType: "CAROUSEL", items: carousel })).toBeNull();
  });
});

describe("publish queue keys", () => {
  const job = { id: "job_1", scheduledAt: new Date("2026-10-01T09:00:00Z") };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never re-queues under the key the running row already holds", () => {
    // enqueue() drops a duplicate idempotencyKey, so an early wake-up that
    // re-used scheduleKey was a silent no-op and the post never went out
    vi.setSystemTime(new Date("2026-10-01T08:00:00Z"));
    expect(wakeKey(job)).not.toBe(scheduleKey(job));
  });

  it("collapses two workers waking the same job in one minute, and sleeps again in the next", () => {
    vi.setSystemTime(new Date("2026-10-01T08:00:10Z"));
    const first = wakeKey(job);
    vi.setSystemTime(new Date("2026-10-01T08:00:59Z"));
    expect(wakeKey(job)).toBe(first);
    vi.setSystemTime(new Date("2026-10-01T08:01:00Z"));
    expect(wakeKey(job)).not.toBe(first);
  });

  it("parks the sleeping row outside the minute its own key buckets on", () => {
    // the drain is a tight claim loop: parked at scheduledAt, a row the database
    // already considers due (its clock is what woke this pass early) comes back
    // in the same minute, re-enqueues under the same wakeKey, and enqueue drops
    // it — nothing queued, post abandoned. The margin is what ends that loop.
    vi.setSystemTime(new Date("2026-10-01T08:59:59Z"));
    const soon = new Date("2026-10-01T09:00:00Z"); // a second away — already due by the clock that woke us
    const sleeper = { id: "job_1", scheduledAt: soon };
    const keyNow = wakeKey(sleeper);
    const parked = wakeRunAt(soon);
    expect(parked.getTime()).toBeGreaterThan(soon.getTime());
    vi.setSystemTime(parked);
    expect(wakeKey(sleeper)).not.toBe(keyNow);
  });

  it("leaves a genuinely distant schedule exactly where it is", () => {
    vi.setSystemTime(new Date("2026-10-01T08:00:00Z"));
    expect(wakeRunAt(job.scheduledAt)).toBe(job.scheduledAt);
  });

  it("keeps every re-queue key of one job distinct from the others", () => {
    vi.setSystemTime(new Date("2026-10-01T08:00:00Z"));
    const keys = [
      scheduleKey(job),
      wakeKey(job),
      publishRunKey(job.id, "poll:1"),
      publishRunKey(job.id, "quota:1"),
      publishRunKey(job.id, "rl:1"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("retryDelayForPublishError", () => {
  const metaError = (code: number) => new MetaApiError({ message: "nope", code }, 400);

  it("waits out a spent publishing quota (code 9) instead of failing the post", () => {
    expect(retryDelayForPublishError(metaError(PUBLISH_QUOTA_ERROR_CODE))).toBe(QUOTA_RETRY_DELAY_MS);
  });

  it("still backs off on a plain rate limit", () => {
    expect(retryDelayForPublishError(metaError(4))).toBe(RATE_LIMIT_RETRY_DELAY_MS);
  });

  it("treats everything else as final for this post", () => {
    expect(retryDelayForPublishError(metaError(100))).toBeNull();
    expect(retryDelayForPublishError(new Error("boom"))).toBeNull();
  });
});

describe("insight metrics per media type", () => {
  it("never asks a story for metrics it does not have (Meta rejects the whole call)", () => {
    const story = insightMetricsFor("STORY");
    expect(story).toContain("replies");
    for (const absent of ["likes", "comments", "saved", "shares"]) expect(story).not.toContain(absent);
  });

  it("keeps the reel and feed sets", () => {
    expect(insightMetricsFor("REELS")).toContain("total_interactions");
    expect(insightMetricsFor("FEED").split(",")).toEqual(["views", "reach", "likes", "comments", "shares", "saved"]);
    expect(insightMetricsFor(null)).toBe(insightMetricsFor("FEED"));
  });

  it("matches however the product type is spelled — Meta says STORY, the publisher writes STORIES", () => {
    expect(insightMetricsFor("STORIES")).toBe(insightMetricsFor("STORY"));
    expect(insightMetricsFor("reels")).toBe(insightMetricsFor("REELS"));
  });
});

describe("contentDispositionFor", () => {
  it("keeps a non-Latin1 name readable without breaking the header", () => {
    const header = contentDispositionFor("Прайс-лист.pdf");
    // a raw UTF-8 header value throws inside the Response constructor → 500
    expect(header).toMatch(/^[\x20-\x7e]*$/);
    expect(header).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(header.split("filename*=UTF-8''")[1]!)).toBe("Прайс-лист.pdf");
  });

  it("gives a plain ASCII fallback and cannot inject a second header", () => {
    expect(contentDispositionFor("price list.pdf")).toBe(`inline; filename="price list.pdf"; filename*=UTF-8''price%20list.pdf`);
    const nasty = contentDispositionFor('a"\r\nX-Evil: 1.pdf');
    expect(nasty).toMatch(/^[\x20-\x7e]*$/); // no CR/LF survives into the header
    expect(nasty).toContain(`filename="a___X-Evil: 1.pdf"`);
  });

  it("percent-encodes what RFC 5987 does not allow in filename*", () => {
    // encodeURIComponent leaves ' ( ) * ! alone; they are not attr-chars
    const encoded = contentDispositionFor("o'brien (final)*.pdf").split("filename*=UTF-8''")[1]!;
    expect(encoded).not.toMatch(/['()*]/);
    expect(decodeURIComponent(encoded)).toBe("o'brien (final)*.pdf");
  });

  it("falls back to a name when there is none, and supports attachment", () => {
    expect(contentDispositionFor("   ")).toBe(`inline; filename="file"; filename*=UTF-8''file`);
    expect(contentDispositionFor("a.pdf", "attachment")).toMatch(/^attachment; /);
  });
});
