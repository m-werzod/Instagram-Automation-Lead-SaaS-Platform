import { describe, expect, it } from "vitest";
import { buildState, verifyState, instagramAuthorizeUrl, facebookAuthorizeUrl, IG_LOGIN_SCOPES } from "@/lib/meta/oauth";
import { checkLoginFormat, checkPasswordPolicy, normalizeLogin } from "@/lib/auth/password";
import { rateLimit, _resetRateLimiter } from "@/lib/rate-limit";

describe("OAuth state (CSRF)", () => {
  it("round-trips a signed state", () => {
    const state = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "admin1", nonce: "n1" });
    const parsed = verifyState(state);
    expect(parsed.adminId).toBe("admin1");
    expect(parsed.mode).toBe("INSTAGRAM_LOGIN");
  });

  it("rejects tampered state", () => {
    const state = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "admin1", nonce: "n1" });
    const [body] = state.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), adminId: "attacker" }),
    ).toString("base64url");
    expect(() => verifyState(`${forgedBody}.${state.split(".")[1]}`)).toThrow(/state/i);
  });

  it("rejects garbage", () => {
    expect(() => verifyState("abc")).toThrow();
    expect(() => verifyState("a.b")).toThrow();
  });

  it("authorize URLs carry required params and current scopes", () => {
    const state = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "a", nonce: "n" });
    const ig = new URL(instagramAuthorizeUrl(state));
    expect(ig.host).toBe("www.instagram.com");
    expect(ig.searchParams.get("response_type")).toBe("code");
    expect(ig.searchParams.get("scope")).toBe(IG_LOGIN_SCOPES.join(","));
    expect(ig.searchParams.get("state")).toBe(state);

    const fb = new URL(facebookAuthorizeUrl(state));
    expect(fb.host).toBe("www.facebook.com");
    expect(fb.searchParams.get("scope")).toContain("ads_management");
    expect(fb.searchParams.get("scope")).toContain("instagram_manage_messages");
  });
});

describe("password policy", () => {
  it("accepts a strong password", () => {
    expect(checkPasswordPolicy("CorrectHorse42Battery").ok).toBe(true);
  });
  it("accepts a 9-character mixed-case password with a digit", () => {
    expect(checkPasswordPolicy("Sample123X").ok).toBe(true);
  });
  it("rejects too-short passwords", () => {
    const res = checkPasswordPolicy("Ab1");
    expect(res.ok).toBe(false);
    expect(res.problems.join(" ")).toMatch(/8 characters/);
  });
  it("requires mixed case and a digit", () => {
    expect(checkPasswordPolicy("alllowercase").problems.join(" ")).toMatch(/upper and lower/);
    expect(checkPasswordPolicy("NoDigitsHere").problems.join(" ")).toMatch(/digit/);
  });
});

describe("login (username) handling", () => {
  it("normalizes case and whitespace so Admin === admin", () => {
    expect(normalizeLogin("  Admin ")).toBe("admin");
    expect(normalizeLogin("ADMIN")).toBe(normalizeLogin("admin"));
  });

  it("accepts valid logins", () => {
    for (const value of ["Admin", "operator1", "a.b_c-d"]) {
      expect(checkLoginFormat(value).ok).toBe(true);
    }
  });

  it("rejects invalid logins with reasons", () => {
    expect(checkLoginFormat("ab").problems.join(" ")).toMatch(/3–40/);
    expect(checkLoginFormat("has space").problems.join(" ")).toMatch(/letters, digits/);
    expect(checkLoginFormat("bad@char").ok).toBe(false);
  });
});

describe("rate limiter", () => {
  it("allows up to the limit then blocks with retry hint", () => {
    _resetRateLimiter();
    for (let i = 0; i < 5; i++) {
      expect(rateLimit("k", 5, 60_000).allowed).toBe(true);
    }
    const blocked = rateLimit("k", 5, 60_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("separate keys do not interfere", () => {
    _resetRateLimiter();
    expect(rateLimit("a", 1, 60_000).allowed).toBe(true);
    expect(rateLimit("b", 1, 60_000).allowed).toBe(true);
    expect(rateLimit("a", 1, 60_000).allowed).toBe(false);
  });
});
