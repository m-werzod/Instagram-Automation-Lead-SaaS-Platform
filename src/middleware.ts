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
  "/api/auth/login",
  "/api/webhooks", // Meta webhook (signature-validated in the route)
  "/api/cron", // scheduler-driven queue drain (CRON_SECRET-validated in the route)
  "/api/health",
  "/api/leads/public", // landing page submissions (rate-limited in route)
  "/_next",
  "/favicon.ico",
];

const SESSION_COOKIE = "ig_admin_session";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
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
