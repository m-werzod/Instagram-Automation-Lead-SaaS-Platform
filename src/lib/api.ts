import { NextRequest, NextResponse } from "next/server";
import { ZodError, type z, type ZodTypeAny } from "zod";
import { AppError } from "@/lib/errors";
import { ConfigError, coreEnv, isProd } from "@/lib/env";
import { createLogger, errorFields } from "@/lib/logger";
import { rateLimit, LIMITS } from "@/lib/rate-limit";
import { sha256Hex } from "@/lib/crypto";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { AIProviderError } from "@/lib/ai/provider";

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
  if (err instanceof AIProviderError) {
    log.warn("ai provider error", { provider: err.provider, status: err.status, message: err.message });
    return fail(
      new AppError("AI_PROVIDER_ERROR", err.userMessage, {
        status: err.retryable ? 503 : 502,
        reason: err.message,
        fix:
          err.status === 402 || err.status === 404
            ? "Change the model in the assistant settings (or AI_MODEL) to one your provider plan includes."
            : err.retryable
              ? "Wait a moment and try again — the queue retries automatically."
              : "Check AI_API_KEY and AI_API_BASE_URL in the environment.",
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

/**
 * Header the hosting platform sets itself, overwriting anything the caller
 * sent. Auto-detected for Vercel; behind another edge (Cloudflare, Akamai) name
 * it with TRUSTED_IP_HEADER. Never guessed from the request: a header that is
 * merely *present* proves nothing — if no upstream strips it, trusting it hands
 * every caller a free identity.
 */
function trustedIpHeader(): string | null {
  const explicit = (process.env.TRUSTED_IP_HEADER ?? "").trim().toLowerCase();
  if (explicit) return explicit;
  if (process.env.VERCEL) return "x-vercel-forwarded-for";
  return null;
}

/** Extra proxies chained BEYOND the one nearest the app (see clientIp). */
function trustedProxyHops(): number {
  const n = Number.parseInt(process.env.TRUSTED_PROXY_HOPS ?? "", 10);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : 0;
}

function normalizeIp(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim().slice(0, 64);
  if (!value) return null;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed) return bracketed[1]!.toLowerCase();
  // one colon = IPv4 with a port; a bare IPv6 address has several
  if ((value.match(/:/g)?.length ?? 0) === 1) return value.split(":")[0]!;
  return value.toLowerCase();
}

/**
 * Caller address used for rate-limit keys and audit rows.
 *
 * X-Forwarded-For is caller-supplied: everything to the LEFT of the entry our
 * own edge appended is whatever the caller invented, so reading the first entry
 * lets anyone mint a fresh identity per request and walk around every IP limit.
 * We therefore read from the right.
 *
 * Assumption: exactly one reverse proxy we control sits in front of the app and
 * appends the address it saw (Vercel, nginx, Cloudflare all do). Chain more
 * proxies and set TRUSTED_PROXY_HOPS to the number of EXTRA hops, so the entry
 * they appended is skipped too.
 *
 * Both fallbacks are only as strong as that assumption, because both headers
 * are ordinary request headers: behind a proxy that writes X-Real-IP but NOT
 * X-Forwarded-For, a caller sending an X-Forwarded-For of their own is read in
 * preference to the real one, and with no proxy at all every value here is
 * theirs. Naming the header the proxy actually writes in TRUSTED_IP_HEADER
 * (`x-real-ip` is a valid answer) removes the guesswork.
 */
export function clientIp(req: NextRequest): string {
  const trusted = trustedIpHeader();
  if (trusted) {
    const platform = normalizeIp(req.headers.get(trusted)?.split(",")[0]);
    if (platform) return platform;
  }

  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    const index = parts.length - 1 - trustedProxyHops();
    // Walking off the left end means TRUSTED_PROXY_HOPS claims more proxies than
    // actually ran, so the chain is shorter than configured. Clamping to
    // parts[0] there would hand the caller the one entry they fully control —
    // the exact bypass this function exists to prevent. The right-most entry is
    // the only one our own edge is known to have written, so prefer that.
    const picked = index >= 0 ? parts[index] : parts[parts.length - 1];
    const ip = normalizeIp(picked);
    if (ip) return ip;
  }

  return normalizeIp(req.headers.get("x-real-ip")) ?? "unknown";
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

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface RouteOptions {
  /**
   * Blanket per-session ceiling for mutating requests (LIMITS.API_WRITE by
   * default). It is a floor under every handler, not a replacement for the
   * tighter, purpose-specific limits routes apply themselves — those use their
   * own keys and still bite first. `false` disables it.
   */
  writeLimit?: { limit: number; windowMs: number } | false;
}

/**
 * Keyed by session, because that is the unit LIMITS.API_WRITE is defined in.
 * Session-less mutating callers — Meta webhooks, the cron drain, the public
 * lead form — deliberately get nothing here: they share no identity, so one
 * bucket would let any of them starve the others. Each already carries its own
 * route-level limit or signature check.
 */
function applyWriteLimit(req: NextRequest, override: RouteOptions["writeLimit"]): void {
  if (override === false) return;
  if (!MUTATING_METHODS.has(req.method.toUpperCase())) return;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return;
  const { limit, windowMs } = override ?? LIMITS.API_WRITE;
  // hashed so a raw session token can never end up in a bucket key or a log line
  enforceRateLimit(`api-write:${sha256Hex(token).slice(0, 32)}`, limit, windowMs);
}

/**
 * Wrap a route handler with error mapping and the default write limit.
 *
 * Generic over the context so a handler may declare its own params shape
 * (`{ params: Promise<{ id: string }> }`) instead of the loose record. The
 * return type is the web `Response` so file downloads and streams — which are
 * not NextResponse — still get the error mapping and the write limit.
 */
export function route<C extends RouteCtx = RouteCtx>(
  handler: (req: NextRequest, ctx: C) => Promise<Response>,
  opts: RouteOptions = {},
) {
  return async (req: NextRequest, ctx: C): Promise<Response> => {
    try {
      applyWriteLimit(req, opts.writeLimit);
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
