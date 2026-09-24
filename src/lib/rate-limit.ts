/**
 * In-process sliding-window rate limiter.
 *
 * SCOPE — read this before relying on it as a security control: the windows
 * live in one process's memory. On a single long-running server that is the
 * whole story, but on serverless (Vercel) each lambda instance keeps its own
 * counters, so a caller spread across N warm instances gets up to N x the
 * nominal limit. It is therefore a throttle, not a boundary. Anything that has
 * to hold regardless of instance count is counted in the database instead —
 * see `loginLockout()`, which is fed by the AuditLog rows the login route
 * already writes. /api/health reports this scope (`rateLimiterInfo()`) so the
 * limiter is never mistaken for a cluster-wide guarantee.
 */

interface Bucket {
  timestamps: number[];
  /**
   * The window this key is counted over. The periodic sweep walks EVERY bucket,
   * so it has to expire each one by its own window: pruning with the window of
   * whichever caller happened to trigger the sweep silently shortens the others.
   * A single API write (60s) would otherwise cut the 15-minute login buckets
   * back to the last minute, turning LOGIN's 5/15min into 5/60s.
   */
  windowMs: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep() {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < bucket.windowMs);
    if (bucket.timestamps.length === 0) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  sweep();
  const now = Date.now();
  const bucket = buckets.get(key) ?? { timestamps: [], windowMs };
  bucket.windowMs = windowMs;
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);

  if (bucket.timestamps.length >= limit) {
    const oldest = bucket.timestamps[0] ?? now;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  bucket.timestamps.push(now);
  buckets.set(key, bucket);
  return { allowed: true, remaining: limit - bucket.timestamps.length, retryAfterSec: 0 };
}

/**
 * Forget one key's window. Exists for the "the attempt succeeded, stop counting
 * it against them" case: a bucket that also counts successes would otherwise
 * lock a legitimate caller out for the rest of the window.
 */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

export const LIMITS = {
  /** login attempts per IP+login — first line only; `loginLockout()` is the durable one */
  LOGIN: { limit: 5, windowMs: 15 * 60_000 },
  /**
   * Login attempts from one IP across ALL logins. Without this, rotating the
   * login name on every attempt (credential spraying) meets no in-process
   * ceiling at all, because the LOGIN key includes the login.
   */
  LOGIN_IP: { limit: 20, windowMs: 15 * 60_000 },
  /** general mutating API calls per session — applied by route() to every mutating handler */
  API_WRITE: { limit: 120, windowMs: 60_000 },
  /** expensive AI calls per session */
  AI: { limit: 20, windowMs: 60_000 },
  /** creating/editing admin or user accounts, per acting admin */
  ADMIN_WRITE: { limit: 10, windowMs: 5 * 60_000 },
  /**
   * Outbound automation-rule actions (DMs, comment replies, resource sends),
   * summed across every rule on one Instagram account — a ceiling independent
   * of any single rule's own cooldown, so a burst that matches several rules
   * at once (or a misconfigured rule with no cooldown) still can't spam an
   * account's whole audience or blow through Meta's own API limits.
   */
  AUTOMATION_ACCOUNT: { limit: 30, windowMs: 60_000 },
} as const;

// ---- durable login lockout (no schema change: counts existing AuditLog rows) ----

/**
 * TRADE-OFF, deliberate: a name-scoped lock can be driven by anyone who knows an
 * admin's login, so an attacker willing to rotate IPs can hold that admin out.
 * It is bounded rather than permanent — a locked request is refused before the
 * password check and so writes no new LOGIN_FAILED row, meaning the lock decays
 * `windowMs` after the last real failure, and the attacker's own IP locks at
 * `perIp` first. We accept that over the alternative, which is a distributed
 * brute force with no ceiling at all once the in-process windows are spread
 * across lambda instances.
 */
export const LOGIN_LOCKOUT = {
  windowMs: 15 * 60_000,
  /** failed attempts against ONE login name before that name is locked */
  perLogin: 10,
  /** failed attempts from ONE IP across any login name (credential spraying) */
  perIp: 25,
} as const;

/**
 * Times of the LOGIN_FAILED rows inside the window, NEWEST FIRST — times rather
 * than plain counts because the moment a lock lifts is decided by one specific
 * failure (see `loginLockout`), and a count cannot name it.
 */
export interface LoginFailures {
  /** failures whose audited login matches */
  forLogin: Date[];
  /** failures from the same IP, any login */
  forIp: Date[];
}

export interface LoginLockoutResult {
  locked: boolean;
  scope: "login" | "ip" | null;
  retryAfterSec: number;
}

/**
 * Decide whether sign-in is locked, from the failures the caller reads out of
 * the AuditLog. Pure on purpose: the counting query needs a database, this
 * decision does not, so the thresholds stay unit-testable.
 */
export function loginLockout(failures: LoginFailures, now: number = Date.now()): LoginLockoutResult {
  const scope: "login" | "ip" | null =
    failures.forLogin.length >= LOGIN_LOCKOUT.perLogin
      ? "login"
      : failures.forIp.length >= LOGIN_LOCKOUT.perIp
        ? "ip"
        : null;
  if (!scope) return { locked: false, scope: null, retryAfterSec: 0 };

  const times = scope === "login" ? failures.forLogin : failures.forIp;
  const threshold = scope === "login" ? LOGIN_LOCKOUT.perLogin : LOGIN_LOCKOUT.perIp;
  // The lock lifts when the count falls BELOW the threshold, which happens as
  // the threshold-th newest failure leaves the window — not as the oldest one
  // does. With more failures than the threshold the oldest expires long before
  // the lock ends, so counting from it would promise a return we do not honour.
  const decisive = times[threshold - 1]?.getTime();
  const retryAfterSec =
    decisive !== undefined && Number.isFinite(decisive)
      ? Math.max(1, Math.ceil((decisive + LOGIN_LOCKOUT.windowMs - now) / 1000))
      : Math.ceil(LOGIN_LOCKOUT.windowMs / 1000);
  return { locked: true, scope, retryAfterSec };
}

/** What /api/health reports about limiter durability — honest, not reassuring. */
export function rateLimiterInfo() {
  return {
    scope: "per-instance" as const,
    durableLoginLockout: true,
    loginLockout: {
      windowMinutes: Math.round(LOGIN_LOCKOUT.windowMs / 60_000),
      perLogin: LOGIN_LOCKOUT.perLogin,
      perIp: LOGIN_LOCKOUT.perIp,
    },
    note:
      "Rate-limit windows are counted in each server instance's memory; on serverless every instance counts separately, so the effective ceiling is the limit times the number of warm instances. Only the login lockout is counted in the database and holds across instances.",
  };
}

/** test hook */
export function _resetRateLimiter() {
  buckets.clear();
  lastSweep = Date.now();
}
