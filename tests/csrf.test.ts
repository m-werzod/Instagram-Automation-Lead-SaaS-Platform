import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { assertSameOrigin, isLocalHostname, trustedHosts } from "@/lib/api";
import { _resetCoreEnvCache } from "@/lib/env";
import { AppError } from "@/lib/errors";

/**
 * CSRF origin policy. The guard must stay permissive enough that the app works
 * when opened as 127.0.0.1 / a LAN IP / a fallback port during development,
 * while never accepting a genuinely remote origin.
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
