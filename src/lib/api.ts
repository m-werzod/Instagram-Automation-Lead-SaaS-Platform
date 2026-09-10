import { NextRequest, NextResponse } from "next/server";
import { ZodError, type z, type ZodTypeAny } from "zod";
import { AppError } from "@/lib/errors";
import { ConfigError, coreEnv, isProd } from "@/lib/env";
import { createLogger, errorFields } from "@/lib/logger";
import { rateLimit } from "@/lib/rate-limit";

const log = createLogger("api");

/**
 * Route-handler toolkit: uniform JSON envelope, central error mapping,
 * zod body parsing, same-origin enforcement for mutations (CSRF defence
 * on top of SameSite=Lax cookies).
 */

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data }, init);
}

export function fail(error: AppError): NextResponse {
  return NextResponse.json({ ok: false, error: error.toJSON() }, { status: error.status });
}

/**
 * Detect "the database is unreachable" so it is never reported as a generic
 * failure — most often this means the DB process simply is not running, which
 * otherwise looks indistinguishable from bad credentials on the sign-in form.
 */
function isDatabaseUnreachable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: string; code?: string; errorCode?: string; message?: string };
  if (e.name === "PrismaClientInitializationError") return true;
  const code = e.code ?? e.errorCode;
  // P1000 auth failed · P1001 can't reach server · P1002 timeout · P1003 db missing · P1017 connection closed
  return code === "P1000" || code === "P1001" || code === "P1002" || code === "P1003" || code === "P1017";
}

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof AppError) {
    if (err.status >= 500) log.error("api error", { code: err.code, ...errorFields(err) });
    return fail(err);
  }
  if (isDatabaseUnreachable(err)) {
    log.error("database unreachable", errorFields(err));
    return fail(
      new AppError("INTERNAL", "Cannot reach the database", {
        status: 503,
        reason: "The application is running but the PostgreSQL server did not respond. This is not a credentials problem.",
        fix: "Start the database (`npm run db:dev` in a normal, non-Administrator terminal) or check DATABASE_URL, then try again.",
      }),
    );
  }
  if (err instanceof ConfigError) {
    return fail(
      new AppError("CONFIG_MISSING", err.message, {
        reason: "A required environment variable is missing or invalid.",
        fix: "Set the variables listed in .env.example and restart the app.",
      }),
    );
  }
  if (err instanceof ZodError) {
    return fail(
      new AppError("VALIDATION", "Invalid input", {
        details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      }),
    );
  }
  log.error("unhandled api error", errorFields(err));
  return fail(
    new AppError("INTERNAL", "Something went wrong on the server", {
      reason: "An unexpected error occurred. Details are in the server logs.",
      fix: "Check server logs; if it persists, restart the app.",
    }),
  );
}

/** Hosts explicitly accepted for state-changing requests. */
export function trustedHosts(): Set<string> {
  const hosts = new Set<string>();
  try {
    hosts.add(new URL(coreEnv().APP_URL).host);
  } catch {
    /* APP_URL validated elsewhere */
  }
  for (const entry of (process.env.TRUSTED_ORIGINS ?? "").split(",")) {
    const value = entry.trim();
    if (!value) continue;
    try {
      hosts.add(new URL(value.includes("://") ? value : `http://${value}`).host);
    } catch {
      /* ignore malformed entries */
    }
  }
  return hosts;
}

/**
 * Loopback / private-network hostnames. Serving the same app as `localhost`,
 * `127.0.0.1` or a LAN IP is routine in development; a remote attacker's page
 * can never present one of these as its Origin.
 */
export function isLocalHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0") return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

/**
 * CSRF defence for state-changing requests.
 *
 * Accepted: the APP_URL host, anything listed in TRUSTED_ORIGINS, and — outside
 * production only — any loopback/private-network host so the app keeps working
 * when opened as 127.0.0.1, a LAN IP, or on a fallback port. Cross-site
 * requests from real remote origins are always rejected (and the session cookie
 * is SameSite=Lax, so it is not even sent on those).
 */
export function assertSameOrigin(req: NextRequest): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const candidate = req.headers.get("origin") ?? req.headers.get("referer");
  if (candidate) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new AppError("FORBIDDEN", "Request rejected: malformed Origin header", {
        reason: `Origin/Referer could not be parsed: ${candidate.slice(0, 100)}`,
        fix: "Use the application UI in a normal browser.",
      });
    }

    if (trustedHosts().has(url.host)) return;
    if (!isProd() && isLocalHostname(url.hostname)) return;

    log.warn("cross-origin request rejected", { origin: url.origin, expected: [...trustedHosts()] });
    throw new AppError("FORBIDDEN", "Cross-origin request rejected", {
      reason: `This request came from ${url.origin}, which is not an approved address for this installation (expected ${[...trustedHosts()].join(", ") || "APP_URL"}).`,
      fix: `Open the app at ${coreEnv().APP_URL}, or add ${url.origin} to TRUSTED_ORIGINS in .env and restart.`,
    });
  }

  // No Origin/Referer: only allow if the request is cookie-less (non-browser client).
  if (req.headers.get("cookie")) {
    throw new AppError("FORBIDDEN", "Missing Origin header on state-changing request", {
      reason: "A browser request carrying session cookies must include an Origin or Referer header.",
      fix: "Use the application UI rather than a custom client.",
    });
  }
}

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function parseBody<S extends ZodTypeAny>(req: NextRequest, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("VALIDATION", "Request body must be valid JSON");
  }
  return schema.parse(raw) as z.output<S>;
}

export function enforceRateLimit(key: string, limit: number, windowMs: number): void {
  const res = rateLimit(key, limit, windowMs);
  if (!res.allowed) {
    throw new AppError("RATE_LIMITED", "Too many requests", {
      reason: "Rate limit exceeded.",
      fix: `Wait ${res.retryAfterSec}s and try again.`,
    });
  }
}

/** Wrap a route handler with error mapping. */
export function route(handler: (req: NextRequest, ctx: RouteCtx) => Promise<NextResponse>) {
  return async (req: NextRequest, ctx: RouteCtx): Promise<NextResponse> => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      return handleApiError(err);
    }
  };
}

export interface RouteCtx {
  params: Promise<Record<string, string>>;
}

/** Extract a required path parameter (noUncheckedIndexedAccess-safe). */
export async function pathParam(ctx: RouteCtx, name: string): Promise<string> {
  const value = (await ctx.params)[name];
  if (!value) throw new AppError("NOT_FOUND", `Missing path parameter: ${name}`);
  return value;
}
