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
    const fbScopes = (fb.searchParams.get("scope") ?? "").split(",");
    expect(fbScopes).toContain("ads_management");
    expect(fbScopes).toContain("leads_retrieval");
  });

  /**
   * Regression guard. Instagram Login authenticates with the INSTAGRAM app id;
   * passing the Facebook app id makes instagram.com reject the request with
   * "Invalid platform app" before the user ever sees a consent screen.
   */
  it("each authorize URL uses its own platform's app id", () => {
    const state = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "a", nonce: "n" });

    const ig = new URL(instagramAuthorizeUrl(state));
    expect(ig.searchParams.get("client_id")).toBe("test-ig-app-id");
    expect(ig.searchParams.get("client_id")).not.toBe("test-fb-app-id");

    const fb = new URL(facebookAuthorizeUrl(state));
    expect(fb.searchParams.get("client_id")).toBe("test-fb-app-id");
  });

  /**
   * Regression guard. Facebook rejects the ENTIRE authorization dialog with
   * "Invalid Scopes" if one requested permission is unavailable to the app.
   * An app set up for Instagram Login does not have the instagram_* or
   * pages_manage_metadata permissions on the Facebook side, so the ads flow
   * must never ask for them.
   */
  it("the Facebook (ads) dialog never requests Instagram-Login-incompatible scopes", () => {
    const forbidden = [
      "instagram_basic",
      "instagram_manage_messages",
      "instagram_manage_comments",
      "instagram_content_publish",
      "instagram_manage_insights",
      "pages_manage_metadata",
    ];
    const scopes = (new URL(facebookAuthorizeUrl(buildState({ mode: "FACEBOOK_LOGIN", adminId: "a", nonce: "n" }))).searchParams.get(
      "scope",
    ) ?? "").split(",");

    for (const scope of forbidden) {
      expect(scopes, `${scope} would break the whole dialog`).not.toContain(scope);
    }
  });

  /**
   * "Add another account" only works if Instagram actually re-asks who is
   * signing in. Without force_reauth it silently re-approves the account
   * already logged in in this browser, so a second connect attempt just
   * re-connects the first account and looks like it did nothing.
   */
  it("only asks Instagram to re-authenticate when switching accounts", () => {
    const state = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "a", nonce: "n" });

    const normal = new URL(instagramAuthorizeUrl(state));
    expect(normal.searchParams.get("force_reauth")).toBeNull();

    const switching = new URL(instagramAuthorizeUrl(state, true));
    expect(switching.searchParams.get("force_reauth")).toBe("true");
    // switching must not change anything else about the request
    expect(switching.searchParams.get("scope")).toBe(normal.searchParams.get("scope"));
    expect(switching.searchParams.get("client_id")).toBe(normal.searchParams.get("client_id"));
    expect(switching.searchParams.get("redirect_uri")).toBe(normal.searchParams.get("redirect_uri"));
  });

  /**
   * An ad account is a billing relationship. The Instagram account it belongs
   * to has to survive the round trip through Facebook inside the SIGNED state —
   * a query parameter on the way back would be attacker-controlled, and
   * guessing would silently bill the wrong profile.
   */
  it("carries the advertising target account inside the signed state", () => {
    const state = buildState({
      mode: "FACEBOOK_LOGIN",
      adminId: "admin1",
      nonce: "n1",
      accountId: "acct_abc",
    });
    expect(verifyState(state).accountId).toBe("acct_abc");

    // and it cannot be swapped for another account without breaking the signature
    const [body, sig] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), accountId: "acct_victim" }),
    ).toString("base64url");
    expect(() => verifyState(`${forged}.${sig}`)).toThrow(/state/i);
  });

  it("omits the target account when none was given", () => {
    const state = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "admin1", nonce: "n1" });
    expect(verifyState(state).accountId).toBeUndefined();
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
