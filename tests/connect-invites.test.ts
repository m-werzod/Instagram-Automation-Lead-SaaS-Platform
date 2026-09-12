import { describe, expect, it } from "vitest";
import type { ConnectInvite } from "@prisma/client";
import { checkInvite, inviteStatus, inviteUrl, INVITE_TTL_HOURS_DEFAULT, INVITE_TTL_HOURS_MAX } from "@/lib/meta/invites";
import { hashSessionToken, randomToken } from "@/lib/crypto";
import { buildState, verifyState } from "@/lib/meta/oauth";

/**
 * Connect invitations are a BEARER credential handed to someone outside the
 * organisation, so the lifecycle rules are the security boundary. These cover
 * the four states an invite can be in and the two ways the token could leak.
 */

function invite(overrides: Partial<ConnectInvite> = {}): ConnectInvite {
  const now = new Date();
  return {
    id: "inv_1",
    tokenHash: "hash",
    label: null,
    createdById: "admin_1",
    expiresAt: new Date(now.getTime() + 3600_000),
    usedAt: null,
    revokedAt: null,
    accountId: null,
    createdAt: now,
    ...overrides,
  } as ConnectInvite;
}

describe("invite lifecycle", () => {
  it("a fresh invite is usable", () => {
    const check = checkInvite(invite());
    expect(check.ok).toBe(true);
    expect(inviteStatus(invite())).toBe("PENDING");
  });

  it("refuses an invite that has already connected an account", () => {
    const used = invite({ usedAt: new Date(), accountId: "acc_1" });
    expect(inviteStatus(used)).toBe("USED");
    const check = checkInvite(used);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe("used");
  });

  it("refuses an expired invite", () => {
    const old = invite({ expiresAt: new Date(Date.now() - 1000) });
    expect(inviteStatus(old)).toBe("EXPIRED");
    const check = checkInvite(old);
    expect(check.ok === false && check.reason).toBe("expired");
  });

  it("refuses a revoked invite", () => {
    const killed = invite({ revokedAt: new Date() });
    expect(inviteStatus(killed)).toBe("REVOKED");
    const check = checkInvite(killed);
    expect(check.ok === false && check.reason).toBe("revoked");
  });

  /**
   * Revocation has to win over everything else: it is the only control an admin
   * has once a link is already in someone else's hands.
   */
  it("revocation beats an otherwise-valid invite", () => {
    const check = checkInvite(invite({ revokedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000) }));
    expect(check.ok === false && check.reason).toBe("revoked");
  });

  it("expiry is checked on the boundary, not approximately", () => {
    expect(inviteStatus(invite({ expiresAt: new Date(Date.now() + 5_000) }))).toBe("PENDING");
    expect(inviteStatus(invite({ expiresAt: new Date(Date.now() - 1) }))).toBe("EXPIRED");
  });
});

describe("invite token handling", () => {
  it("stores a hash, never the token itself", () => {
    const token = randomToken(32);
    const stored = hashSessionToken(token);
    expect(stored).not.toBe(token);
    expect(stored).not.toContain(token);
    // deterministic, so lookup by hash works; and 64 hex chars of sha256
    expect(stored).toBe(hashSessionToken(token));
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints tokens with enough entropy to be unguessable", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(randomToken(32));
    expect(seen.size).toBe(200);
    // 32 bytes base64url — no padding, URL-safe, so it survives being pasted
    // into a chat app and back out again
    const token = randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(42);
  });

  it("builds a link on the app's own origin", () => {
    const url = new URL(inviteUrl("abc123"));
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe("/connect/abc123");
  });

  it("keeps the default lifetime short and the ceiling bounded", () => {
    expect(INVITE_TTL_HOURS_DEFAULT).toBeLessThanOrEqual(24 * 7);
    expect(INVITE_TTL_HOURS_MAX).toBeLessThanOrEqual(24 * 30);
  });
});

/**
 * The invited flow skips the admin-session check in the OAuth callback, so the
 * invite id it trusts must come from the signed state and nowhere else.
 */
describe("invited authorization state", () => {
  it("round-trips the invite id", () => {
    const state = buildState({
      mode: "INSTAGRAM_LOGIN",
      adminId: "admin_1",
      nonce: "n1",
      inviteId: "inv_42",
    });
    expect(verifyState(state).inviteId).toBe("inv_42");
  });

  it("cannot have an invite id grafted on after signing", () => {
    // an admin-initiated authorization, with no invite
    const state = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "admin_1", nonce: "n1" });
    expect(verifyState(state).inviteId).toBeUndefined();

    const [body, sig] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body!, "base64url").toString()),
        inviteId: "inv_attacker",
      }),
    ).toString("base64url");

    // forging it to bypass the session check must fail the signature
    expect(() => verifyState(`${forged}.${sig}`)).toThrow(/state/i);
  });

  it("cannot swap one invite id for another", () => {
    const state = buildState({ mode: "INSTAGRAM_LOGIN", adminId: "a", nonce: "n", inviteId: "inv_mine" });
    const [body, sig] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), inviteId: "inv_yours" }),
    ).toString("base64url");
    expect(() => verifyState(`${forged}.${sig}`)).toThrow(/state/i);
  });
});
