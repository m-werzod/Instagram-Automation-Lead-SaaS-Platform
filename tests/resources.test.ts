import { describe, expect, it } from "vitest";
import { ALLOWED_RESOURCE_MIME, MAX_RESOURCE_BYTES, resourceKindFromMime, resourceUrlFor } from "@/lib/resources";

describe("resourceKindFromMime", () => {
  it("classifies images and videos", () => {
    expect(resourceKindFromMime("image/jpeg")).toBe("IMAGE");
    expect(resourceKindFromMime("image/png")).toBe("IMAGE");
    expect(resourceKindFromMime("video/mp4")).toBe("VIDEO");
  });

  it("everything else (PDF, docs, zip) is a plain FILE — no native Instagram attachment type for it", () => {
    expect(resourceKindFromMime("application/pdf")).toBe("FILE");
    expect(resourceKindFromMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("FILE");
    expect(resourceKindFromMime("application/zip")).toBe("FILE");
  });
});

describe("resourceUrlFor", () => {
  it("builds a public URL on the app's own origin with a real extension", () => {
    const url = new URL(resourceUrlFor("res_1", "application/pdf"));
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe("/r/res_1.pdf");
  });

  it("falls back to a generic extension for an unrecognized mime type", () => {
    expect(resourceUrlFor("res_1", "application/octet-stream")).toBe("http://localhost:3000/r/res_1.bin");
  });
});

describe("resource upload limits", () => {
  it("allows the documented types and stays at the same serverless body cap as publishing", () => {
    expect(ALLOWED_RESOURCE_MIME.has("application/pdf")).toBe(true);
    expect(ALLOWED_RESOURCE_MIME.has("application/x-msdownload")).toBe(false);
    expect(MAX_RESOURCE_BYTES).toBe(4 * 1024 * 1024);
  });
});
