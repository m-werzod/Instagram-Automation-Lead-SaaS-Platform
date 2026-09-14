import { describe, expect, it } from "vitest";
import { isPublicPath } from "@/middleware";

/**
 * Every route Meta or an unauthenticated human must be able to reach with no
 * session cookie has to be listed here — missing one silently redirects Meta's
 * own fetch (or a person's link click) to an HTML login page instead of the
 * resource, which is exactly what shipped once for /r/ before this test existed.
 */
describe("isPublicPath", () => {
  it("lets Meta fetch platform-hosted media with no session", () => {
    expect(isPublicPath("/m/abc123.jpg")).toBe(true);
  });

  it("lets Meta fetch (and a human open) a comment-resource file with no session", () => {
    expect(isPublicPath("/r/abc123.pdf")).toBe(true);
  });

  it("lets the hosted lead-capture landing page and invite flow through", () => {
    expect(isPublicPath("/f/some-slug")).toBe(true);
    expect(isPublicPath("/connect/some-token")).toBe(true);
  });

  it("lets Meta's own webhook, OAuth callback, and the cron drain through (each does its own real auth)", () => {
    expect(isPublicPath("/api/webhooks/instagram")).toBe(true);
    expect(isPublicPath("/api/webhooks/stripe")).toBe(true);
    expect(isPublicPath("/api/meta/oauth/callback")).toBe(true);
    expect(isPublicPath("/api/cron/worker")).toBe(true);
  });

  it("gates an ordinary dashboard page", () => {
    expect(isPublicPath("/dashboard")).toBe(false);
    expect(isPublicPath("/automation")).toBe(false);
  });

  it("gates an ordinary admin API route — the outer cookie check stays defense-in-depth even though the route re-checks", () => {
    expect(isPublicPath("/api/comment-resources")).toBe(false);
    expect(isPublicPath("/api/admin/admins")).toBe(false);
  });

  it("a public prefix only matches its own path or a real sub-path, not a lookalike", () => {
    expect(isPublicPath("/reports")).toBe(false); // must not match "/r/" as a bare prefix of "/re..."
    expect(isPublicPath("/farm")).toBe(false); // must not match "/f/" the same way
  });
});
