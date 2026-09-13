/**
 * In-memory sliding-window rate limiter. Suitable for this single-instance
 * private deployment; swap for a Redis implementation behind the same
 * interface if the app is ever scaled horizontally.
 */

interface Bucket {
  timestamps: number[];
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(windowMs: number) {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
    if (bucket.timestamps.length === 0) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  sweep(windowMs);
  const now = Date.now();
  const bucket = buckets.get(key) ?? { timestamps: [] };
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

export const LIMITS = {
  /** login attempts per IP+email */
  LOGIN: { limit: 5, windowMs: 5 * 60_000 },
  /** general mutating API calls per session */
  API_WRITE: { limit: 120, windowMs: 60_000 },
  /** expensive AI calls per session */
  AI: { limit: 20, windowMs: 60_000 },
  /** creating/editing admin or user accounts, per acting admin */
  ADMIN_WRITE: { limit: 10, windowMs: 5 * 60_000 },
} as const;

/** test hook */
export function _resetRateLimiter() {
  buckets.clear();
}
