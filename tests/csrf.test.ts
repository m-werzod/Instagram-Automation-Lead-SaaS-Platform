import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { assertSameOrigin, clientIp, isLocalHostname, route, trustedHosts, ok } from "@/lib/api";
import { _resetCoreEnvCache } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { LIMITS, LOGIN_LOCKOUT, loginLockout, rateLimit, rateLimiterInfo, resetRateLimit, _resetRateLimiter } from "@/lib/rate-limit";
import { redact } from "@/lib/logger";

/**
 * Request-identity and abuse controls: who the server believes you are (origin,
 * IP), how often it lets you write, and what it refuses to print. Every one of
 * these is attacker-supplied input, so each case below is a bypass someone
 * would otherwise get for free.
 *
 * CSRF origin policy first. The guard must stay permissive enough that the app
 * works when opened as 127.0.0.1 / a LAN IP / a fallback port during
 * development, while never accepting a genuinely remote origin.
 */

function post(origin?: string, opts: { cookie?: boolean; referer?: string } = {}) {
  const headers = new Headers();
  if (origin) headers.set("origin", origin);
  if (opts.referer) headers.set("referer", opts.referer);
  if (opts.cookie) headers.set("cookie", "ig_admin_session=abc");
  return new NextRequest("http://localhost:3000/api/auth/login", { method: "POST", headers });
}

function allows(req: NextRequest): boolean {
  try {
    assertSameOrigin(req);
    return true;
  } catch {
    return false;
  }
}

/** process.env.NODE_ENV is typed read-only; tests need to flip it deliberately. */
function setNodeEnv(value: string) {
  (process.env as unknown as Record<string, string>).NODE_ENV = value;
  _resetCoreEnvCache();
}

afterEach(() => {
  delete process.env.TRUSTED_ORIGINS;
  delete process.env.TRUSTED_IP_HEADER;
  delete process.env.TRUSTED_PROXY_HOPS;
  delete process.env.VERCEL;
  _resetRateLimiter();
  setNodeEnv("test");
});

describe("isLocalHostname", () => {
  it("accepts loopback and private ranges", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "10.87.73.231", "192.168.1.50", "172.16.0.9", "172.31.255.1"]) {
      expect(isLocalHostname(h), h).toBe(true);
    }
  });

  it("rejects public hostnames — including look-alikes", () => {
    for (const h of ["evil.com", "localhost.evil.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "11.0.0.1", "192.169.1.1"]) {
      expect(isLocalHostname(h), h).toBe(false);
    }
  });
});

describe("assertSameOrigin", () => {
  it("never blocks safe methods", () => {
    const req = new NextRequest("http://localhost:3000/api/health", {
      method: "GET",
      headers: new Headers({ origin: "https://evil.com" }),
    });
    expect(allows(req)).toBe(true);
  });

  it("allows the APP_URL origin", () => {
    expect(allows(post("http://localhost:3000"))).toBe(true);
  });

  it("allows loopback, LAN and fallback-port origins in development", () => {
    expect(allows(post("http://127.0.0.1:3000"))).toBe(true);
    expect(allows(post("http://10.87.73.231:3000"))).toBe(true);
    expect(allows(post("http://localhost:3001"))).toBe(true);
  });

  it("rejects a remote origin", () => {
    expect(allows(post("https://evil-attacker.com"))).toBe(false);
  });

  it("reports the offending origin and how to allow it", () => {
    try {
      assertSameOrigin(post("https://evil-attacker.com"));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const e = err as AppError;
      expect(e.code).toBe("FORBIDDEN");
      expect(e.reason).toContain("https://evil-attacker.com");
      expect(e.fix).toContain("TRUSTED_ORIGINS");
    }
  });

  it("honours TRUSTED_ORIGINS for non-local hosts", () => {
    expect(allows(post("https://ops.example.com"))).toBe(false);
    process.env.TRUSTED_ORIGINS = "https://ops.example.com, bare-host.example:8080";
    expect(trustedHosts().has("ops.example.com")).toBe(true);
    expect(trustedHosts().has("bare-host.example:8080")).toBe(true);
    expect(allows(post("https://ops.example.com"))).toBe(true);
    expect(allows(post("http://bare-host.example:8080"))).toBe(true);
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(allows(post(undefined, { referer: "http://localhost:3000/login" }))).toBe(true);
    expect(allows(post(undefined, { referer: "https://evil.com/x" }))).toBe(false);
  });

  it("rejects a malformed Origin", () => {
    expect(allows(post("not-a-url"))).toBe(false);
  });

  it("allows header-less non-browser calls only when cookie-less", () => {
    expect(allows(post())).toBe(true);
    expect(allows(post(undefined, { cookie: true }))).toBe(false);
  });

  it("in production, local origins are NOT auto-trusted", () => {
    setNodeEnv("production");
    // APP_URL itself still works…
    expect(allows(post("http://localhost:3000"))).toBe(true);
    // …but another local address does not, unless explicitly trusted.
    expect(allows(post("http://127.0.0.1:3000"))).toBe(false);
    expect(allows(post("http://10.87.73.231:3000"))).toBe(false);
  });
});

/**
 * clientIp keys every IP rate limit and every audit row, so reading the wrong
 * entry of X-Forwarded-For is not cosmetic: the caller writes that header, and
 * picking their entry hands them a fresh identity per request.
 */
describe("clientIp", () => {
  function withHeaders(headers: Record<string, string>) {
    return new NextRequest("http://localhost:3000/api/auth/login", { method: "POST", headers: new Headers(headers) });
  }

  it("ignores the entries the caller invented and keeps the one our edge appended", () => {
    const req = withHeaders({ "x-forwarded-for": "1.2.3.4, 9.9.9.9, 203.0.113.7" });
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  it("cannot be spoofed by a single forged entry", () => {
    expect(clientIp(withHeaders({ "x-forwarded-for": "8.8.8.8" }))).toBe("8.8.8.8");
    // …and a second request that prepends a victim address still resolves to
    // the same real peer, so the limiter keeps counting the same bucket.
    expect(clientIp(withHeaders({ "x-forwarded-for": "10.0.0.1, 8.8.8.8" }))).toBe("8.8.8.8");
  });

  it("skips extra proxy hops when TRUSTED_PROXY_HOPS says how many to skip", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(clientIp(withHeaders({ "x-forwarded-for": "1.2.3.4, 203.0.113.7, 10.0.0.5" }))).toBe("203.0.113.7");
  });

  /**
   * An over-stated hop count means the chain is shorter than configured. Falling
   * back to the left-most entry there would return the one value the caller
   * fully controls — a misconfiguration must not reopen the spoof.
   */
  it("falls back to our own edge's entry when TRUSTED_PROXY_HOPS overshoots the chain", () => {
    process.env.TRUSTED_PROXY_HOPS = "5";
    expect(clientIp(withHeaders({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(withHeaders({ "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
  });

  it("prefers a platform header the caller cannot set", () => {
    process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
    const req = withHeaders({ "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": "1.2.3.4, 203.0.113.7" });
    expect(clientIp(req)).toBe("198.51.100.9");
  });

  it("does not trust a platform header nobody upstream strips", () => {
    // No TRUSTED_IP_HEADER and no VERCEL: cf-connecting-ip is just caller input.
    const req = withHeaders({ "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": "203.0.113.7" });
    expect(clientIp(req)).toBe("203.0.113.7");
  });

  it("normalizes ports and bracketed IPv6, and admits when it has nothing", () => {
    expect(clientIp(withHeaders({ "x-forwarded-for": "203.0.113.7:51234" }))).toBe("203.0.113.7");
    expect(clientIp(withHeaders({ "x-forwarded-for": "[2001:DB8::1]:443" }))).toBe("2001:db8::1");
    expect(clientIp(withHeaders({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(withHeaders({}))).toBe("unknown");
  });
});

/**
 * LIMITS.API_WRITE was declared but never applied to anything. route() is the
 * one place that sees every mutating handler, so the floor belongs there.
 */
describe("default write limit", () => {
  const handler = route(async () => ok({ done: true }));
  const ctx = { params: Promise.resolve({}) };

  function write(method = "POST", cookie = "ig_admin_session=session-token-a") {
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    return new NextRequest("http://localhost:3000/api/anything", { method, headers });
  }

  async function statusesFor(count: number, req: () => NextRequest, handle = handler) {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push((await handle(req(), ctx)).status);
    return out;
  }

  it("stops a session that exceeds API_WRITE, with a 429 envelope", async () => {
    const statuses = await statusesFor(LIMITS.API_WRITE.limit + 2, () => write());
    expect(statuses.filter((s) => s === 200)).toHaveLength(LIMITS.API_WRITE.limit);
    expect(statuses.at(-1)).toBe(429);

    const body = (await (await handler(write(), ctx)).json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("counts per session, not globally", async () => {
    await statusesFor(LIMITS.API_WRITE.limit, () => write());
    const other = await handler(write("POST", "ig_admin_session=session-token-b"), ctx);
    expect(other.status).toBe(200);
  });

  it("never touches reads", async () => {
    const statuses = await statusesFor(LIMITS.API_WRITE.limit + 5, () => write("GET"));
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  /**
   * Webhooks and the cron drain mutate without a session. One shared bucket for
   * all of them would let any caller starve Meta's deliveries, so they are left
   * to the signature / secret checks and limits their own routes apply.
   */
  it("leaves session-less callers to their own route-level limits", async () => {
    const statuses = await statusesFor(LIMITS.API_WRITE.limit + 5, () => write("POST", ""));
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it("can be overridden per route", async () => {
    const strict = route(async () => ok({ done: true }), { writeLimit: { limit: 2, windowMs: 60_000 } });
    expect(await statusesFor(3, () => write(), strict)).toEqual([200, 200, 429]);

    _resetRateLimiter();
    const off = route(async () => ok({ done: true }), { writeLimit: false });
    const statuses = await statusesFor(LIMITS.API_WRITE.limit + 3, () => write(), off);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });
});

/**
 * The periodic sweep walks every bucket at once, so it is the one place where
 * limits with different windows can corrupt each other. Now that route() puts a
 * 60-second API_WRITE bucket behind every mutating request, a sweep triggered by
 * ordinary traffic runs constantly — and must not shorten anyone else's window.
 */
describe("rate-limit bucket expiry", () => {
  const LOGIN_KEY = "login:203.0.113.7:admin";

  function exhaustLogin() {
    for (let i = 0; i < LIMITS.LOGIN.limit; i++) {
      rateLimit(LOGIN_KEY, LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs);
    }
  }

  function atFakeTime(run: (advanceTo: (ms: number) => void) => void) {
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-01-01T00:00:00.000Z").getTime();
      vi.setSystemTime(t0);
      _resetRateLimiter();
      run((ms) => vi.setSystemTime(t0 + ms));
    } finally {
      vi.useRealTimers();
    }
  }

  it("does not let a short-window limit prune a long-window one", () => {
    atFakeTime((advanceTo) => {
      exhaustLogin();
      // Two minutes on: long past API_WRITE's window, nowhere near LOGIN's.
      advanceTo(2 * 60_000);
      rateLimit("api-write:someone-else", LIMITS.API_WRITE.limit, LIMITS.API_WRITE.windowMs);

      expect(rateLimit(LOGIN_KEY, LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs).allowed).toBe(false);
    });
  });

  it("still forgets a bucket once its own window has passed", () => {
    atFakeTime((advanceTo) => {
      exhaustLogin();
      advanceTo(LIMITS.LOGIN.windowMs + 1_000);
      expect(rateLimit(LOGIN_KEY, LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs).allowed).toBe(true);
    });
  });

  /**
   * The login bucket counts every attempt, successes included, over fifteen
   * minutes. Without this the admin who signs in from a laptop, a phone and a
   * second browser locks themselves out of their own account for the rest of
   * the window — so the login route clears the bucket on a correct password.
   */
  it("forgets a bucket on demand, so a success can clear its own failures", () => {
    exhaustLogin();
    expect(rateLimit(LOGIN_KEY, LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs).allowed).toBe(false);
    resetRateLimit(LOGIN_KEY);
    expect(rateLimit(LOGIN_KEY, LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs).allowed).toBe(true);
    // and only that key
    resetRateLimit("login:203.0.113.7:someone-else");
    expect(rateLimit(LOGIN_KEY, LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs).remaining).toBe(LIMITS.LOGIN.limit - 2);
  });
});

/**
 * The in-memory limiter is per-instance, so on serverless it cannot hold a
 * brute-force ceiling on its own. The durable half counts the LOGIN_FAILED
 * audit rows; this is the decision it makes from those counts.
 */
describe("loginLockout", () => {
  const NOW = new Date("2026-01-01T12:00:00.000Z").getTime();
  /** `count` failures a minute apart, newest first — the order the route reads them in. */
  const failures = (count: number, newestAgoMs = 0) =>
    Array.from({ length: count }, (_, i) => new Date(NOW - newestAgoMs - i * 60_000));

  it("lets normal mistyping through", () => {
    expect(loginLockout({ forLogin: failures(LOGIN_LOCKOUT.perLogin - 1), forIp: [] }, NOW).locked).toBe(false);
  });

  it("locks a login that keeps failing, wherever the attempts come from", () => {
    const res = loginLockout({ forLogin: failures(LOGIN_LOCKOUT.perLogin), forIp: failures(1) }, NOW);
    expect(res.locked).toBe(true);
    expect(res.scope).toBe("login");
  });

  it("locks an address spraying many different logins", () => {
    const res = loginLockout({ forLogin: failures(1), forIp: failures(LOGIN_LOCKOUT.perIp) }, NOW);
    expect(res.locked).toBe(true);
    expect(res.scope).toBe("ip");
  });

  it("reports when the lock lifts, counted from the newest failure when it is only just locked", () => {
    const res = loginLockout({ forLogin: failures(LOGIN_LOCKOUT.perLogin, 60_000), forIp: [] }, NOW);
    // exactly at the threshold, so the last of them is also the decisive one
    const decisiveAgoMs = 60_000 + (LOGIN_LOCKOUT.perLogin - 1) * 60_000;
    expect(res.retryAfterSec).toBe(Math.ceil((LOGIN_LOCKOUT.windowMs - decisiveAgoMs) / 1000));
  });

  /**
   * Past the threshold the oldest failure expires long before the lock ends:
   * quoting it tells the user to come back at a time they will still be refused.
   * What matters is the threshold-th newest — the one whose expiry drops the
   * count below the limit.
   */
  it("counts the lift from the failure that drops the count below the threshold, not the oldest", () => {
    const res = loginLockout({ forLogin: failures(LOGIN_LOCKOUT.perLogin * 2), forIp: [] }, NOW);
    const decisiveAgoMs = (LOGIN_LOCKOUT.perLogin - 1) * 60_000;
    expect(res.retryAfterSec).toBe(Math.ceil((LOGIN_LOCKOUT.windowMs - decisiveAgoMs) / 1000));
    // the oldest of those would have claimed the lock had already lifted
    expect(res.retryAfterSec).toBeGreaterThan(1);
  });

  it("falls back to the full window rather than a NaN wait when a timestamp is unusable", () => {
    const forLogin = failures(LOGIN_LOCKOUT.perLogin);
    forLogin[LOGIN_LOCKOUT.perLogin - 1] = new Date(Number.NaN);
    const res = loginLockout({ forLogin, forIp: [] }, NOW);
    expect(res.retryAfterSec).toBe(Math.ceil(LOGIN_LOCKOUT.windowMs / 1000));
  });

  /**
   * /api/health publishes this. An operator reading it must not come away
   * believing the in-memory windows survive a second lambda instance — the
   * whole reason the durable lockout above exists.
   */
  it("declares the in-memory limiter's real scope rather than implying a cluster-wide one", () => {
    const info = rateLimiterInfo();
    expect(info.scope).toBe("per-instance");
    expect(info.note).toMatch(/instance/i);
    expect(info.durableLoginLockout).toBe(true);
    expect(info.loginLockout).toEqual({
      windowMinutes: Math.round(LOGIN_LOCKOUT.windowMs / 60_000),
      perLogin: LOGIN_LOCKOUT.perLogin,
      perIp: LOGIN_LOCKOUT.perIp,
    });
  });
});

/**
 * Redaction used to give up below depth 4 and return the raw sub-tree, so a
 * secret nested deeply enough was logged in the clear — exactly where it is
 * hardest to notice.
 */
describe("log redaction", () => {
  it("redacts at any depth", () => {
    const deep = { a: { b: { c: { d: { e: { f: { accessToken: "SECRET", note: "keep" } } } } } } };
    const line = JSON.stringify(redact(deep));
    expect(line).not.toContain("SECRET");
    expect(line).toContain("[REDACTED]");
    expect(line).toContain("keep");
  });

  it("redacts inside arrays and regardless of key casing", () => {
    const line = JSON.stringify(redact({ items: [{ headers: { Authorization: "Bearer SECRET" } }] }));
    expect(line).not.toContain("SECRET");
  });

  it("drops what it cannot inspect instead of passing it through", () => {
    let node: Record<string, unknown> = { token: "SECRET" };
    for (let i = 0; i < 40; i++) node = { nested: node };
    const line = JSON.stringify(redact(node));
    expect(line).not.toContain("SECRET");
    expect(line).toContain("TRUNCATED");
  });

  it("survives a cycle but still prints repeated siblings", () => {
    const shared = { name: "same" };
    const cyclic: Record<string, unknown> = { shared, also: shared };
    cyclic.self = cyclic;
    const line = JSON.stringify(redact(cyclic));
    expect(line).toContain("[CIRCULAR]");
    expect(line.match(/same/g)).toHaveLength(2);
  });
});
