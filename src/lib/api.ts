import { NextRequest, NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { AppError } from "@/lib/errors";
import { ConfigError, coreEnv } from "@/lib/env";
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

export function handleApiError(err: unknown): NextResponse {
  if (err instanceof AppError) {
    if (err.status >= 500) log.error("api error", { code: err.code, ...errorFields(err) });
    return fail(err);
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

/**
 * CSRF defence for state-changing requests: the Origin (or Referer) host must
 * match APP_URL's host. Browsers always send Origin on cross-site POSTs.
 * Requests without either header (curl, server-to-server with the session
 * cookie absent) are allowed only when they carry no cookies.
 */
export function assertSameOrigin(req: NextRequest): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const appHost = new URL(coreEnv().APP_URL).host;
  const origin = req.headers.get("origin");
  const referer = req.headers.get("referer");

  const candidate = origin ?? referer;
  if (candidate) {
    try {
      if (new URL(candidate).host === appHost) return;
    } catch {
      /* fallthrough */
    }
    throw new AppError("FORBIDDEN", "Cross-origin request rejected", {
      reason: "The request Origin does not match APP_URL.",
      fix: "Use the app UI, or set APP_URL to the address you are browsing from.",
    });
  }
  // No Origin/Referer: only allow if the request is cookie-less (non-browser client).
  if (req.headers.get("cookie")) {
    throw new AppError("FORBIDDEN", "Missing Origin header on state-changing request");
  }
}

export function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function parseBody<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("VALIDATION", "Request body must be valid JSON");
  }
  return schema.parse(raw);
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
