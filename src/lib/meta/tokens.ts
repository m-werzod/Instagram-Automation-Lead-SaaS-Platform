import type { InstagramAccount, InstagramToken } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { tokenExpired } from "@/lib/errors";
import type { GraphHost } from "./client";

/**
 * Token access layer. Tokens are AES-256-GCM encrypted at rest and only
 * decrypted transiently for API calls. They never leave the server process.
 */

export interface ResolvedAccess {
  accessToken: string;
  host: GraphHost;
  tokenRow: InstagramToken;
}

/**
 * Token kinds stored per account:
 *   user — the organic-features token (Instagram Login, or FB user token in mode B)
 *   page — Facebook Page token (webhooks, Instant Forms)
 *   ads  — Facebook user token carrying ads_management, kept SEPARATE so
 *          connecting Facebook for advertising never revokes the Instagram
 *          Login token that messaging depends on.
 */
export type TokenKind = "user" | "page" | "ads";

export async function storeToken(opts: {
  accountId: string;
  kind: TokenKind;
  token: string;
  scopes: string[];
  expiresAt: Date | null;
}): Promise<InstagramToken> {
  // one active token per (account, kind): revoke predecessors
  await prisma.instagramToken.updateMany({
    where: { accountId: opts.accountId, kind: opts.kind, status: "ACTIVE" },
    data: { status: "REVOKED" },
  });
  return prisma.instagramToken.create({
    data: {
      accountId: opts.accountId,
      kind: opts.kind,
      encrypted: encryptSecret(opts.token),
      scopes: opts.scopes,
      expiresAt: opts.expiresAt,
      status: "ACTIVE",
    },
  });
}

export async function getActiveToken(
  accountId: string,
  kind: TokenKind,
): Promise<{ token: string; row: InstagramToken } | null> {
  const row = await prisma.instagramToken.findFirst({
    where: { accountId, kind, status: "ACTIVE" },
    orderBy: { issuedAt: "desc" },
  });
  if (!row) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    await prisma.instagramToken.update({ where: { id: row.id }, data: { status: "EXPIRED" } });
    return null;
  }
  return { token: decryptSecret(row.encrypted), row };
}

/**
 * Resolve the token + host to use for organic Instagram operations
 * (profile, media, messaging, comments, insights) for this account.
 *  - Mode A: IG user token on graph.instagram.com
 *  - Mode B: Page token on graph.facebook.com
 */
export async function resolveAccess(account: InstagramAccount): Promise<ResolvedAccess> {
  if (account.connectionMode === "INSTAGRAM_LOGIN") {
    const t = await getActiveToken(account.id, "user");
    if (!t) throw tokenExpired();
    return { accessToken: t.token, host: "graph.instagram.com", tokenRow: t.row };
  }
  const t = await getActiveToken(account.id, "page");
  if (!t) throw tokenExpired();
  return { accessToken: t.token, host: "graph.facebook.com", tokenRow: t.row };
}

/**
 * Marketing API calls use the dedicated ads token when one exists (an account
 * connected with Instagram Login that later added Facebook for advertising),
 * falling back to the user token for accounts connected entirely through
 * Facebook Login.
 */
export async function resolveAdsAccess(account: InstagramAccount): Promise<ResolvedAccess> {
  const ads = await getActiveToken(account.id, "ads");
  if (ads) return { accessToken: ads.token, host: "graph.facebook.com", tokenRow: ads.row };

  if (account.connectionMode === "FACEBOOK_LOGIN") {
    const user = await getActiveToken(account.id, "user");
    if (user) return { accessToken: user.token, host: "graph.facebook.com", tokenRow: user.row };
  }
  throw tokenExpired();
}

export async function markTokenExpired(tokenId: string): Promise<void> {
  await prisma.instagramToken.update({ where: { id: tokenId }, data: { status: "EXPIRED" } }).catch(() => undefined);
}
