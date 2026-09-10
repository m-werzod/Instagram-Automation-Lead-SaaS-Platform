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

export async function storeToken(opts: {
  accountId: string;
  kind: "user" | "page";
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
  kind: "user" | "page",
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

/** Marketing API calls require the mode-B USER token. */
export async function resolveAdsAccess(account: InstagramAccount): Promise<ResolvedAccess> {
  const t = await getActiveToken(account.id, "user");
  if (!t) throw tokenExpired();
  return { accessToken: t.token, host: "graph.facebook.com", tokenRow: t.row };
}

export async function markTokenExpired(tokenId: string): Promise<void> {
  await prisma.instagramToken.update({ where: { id: tokenId }, data: { status: "EXPIRED" } }).catch(() => undefined);
}
