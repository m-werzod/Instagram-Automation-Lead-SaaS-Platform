import { NextRequest, NextResponse } from "next/server";

/**
 * Edge middleware: cheap cookie-presence gate for dashboard pages.
 * Full session validation (DB) happens in the (dashboard) layout and in
 * every API route via requireAdmin() — this only prevents obviously
 * anonymous requests from rendering protected shells.
 */

const PUBLIC_PREFIXES = [
  "/login",
  "/f/", // public hosted lead-capture landing pages
  "/connect/", // invitation pages — opened by the Instagram account OWNER, who has no session here
  "/api/connect/", // starts the invited authorization (the invite token IS the authorization)
  // Meta sends the account OWNER back here after an invited authorization, and
  // they have no session — so this cannot be gated on a cookie. The route does
  // the real check either way: a matching admin session for an admin-initiated
  // flow, a valid unused invitation for an invited one, and an HMAC-signed
  // state for both.
  "/api/meta/oauth/callback",
  "/api/auth/login",
  "/api/webhooks", // Meta webhook (signature-validated in the route)
  "/api/cron", // scheduler-driven queue drain (CRON_SECRET-validated in the route)
  "/api/health",
  "/api/setup-status", // readiness probe — must work before the app is configured
  "/api/leads/public", // landing page submissions (rate-limited in route)
  "/m/", // platform-hosted media that Meta downloads while publishing (public by design)
  "/r/", // platform-hosted comment-resource files — Meta attachment fetches and a human's link-fallback click both arrive with no session
  // Rendered video served under a short-lived signed token, so Meta can download
  // it during publishing. Instagram fetches media from a URL rather than
  // accepting an upload, and that fetch carries no session. The route verifies
  // the HMAC and expiry itself, and refuses to serve anything but an EXPORT or
  // THUMBNAIL — a source video or an uploaded music track is never reachable.
  "/v/",
  "/_next",
  "/favicon.ico",
];

const SESSION_COOKIE = "ig_admin_session";

/**
 * Pure (unit-tested): does this pathname skip the session-cookie gate?
 *
 * Matching is on whole path SEGMENTS, never a bare string prefix. An entry that
 * already ends in "/" is a sub-tree ("/r/" covers "/r/file.pdf"); one that does
 * not must match exactly or be followed by "/". Bare `startsWith` let an entry
 * shadow a sibling that merely begins with the same letters — "/api/leads/public"
 * also matched "/api/leads/publicXYZ", which Next.js routes to /api/leads/[id],
 * so an unauthenticated request to a CRM lead skipped this gate (the route's own
 * requireAdmin() still refused it, but the outer gate is supposed to hold).
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (!hasSession) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { ok: false, error: { code: "UNAUTHORIZED", message: "Authentication required" } },
        { status: 401 },
      );
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
