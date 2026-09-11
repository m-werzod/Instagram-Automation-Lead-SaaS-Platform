import type { InstagramAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createLogger, errorFields } from "@/lib/logger";
import { graphCall, MetaApiError } from "./client";
import {
  fbExchangeCode,
  fbExchangeLongLived,
  igExchangeCode,
  igExchangeLongLived,
  igRefreshLongLived,
  igLoginScopes,
} from "./oauth";
import { getActiveToken, markTokenExpired, resolveAccess, storeToken } from "./tokens";
import { AppError, notFound } from "@/lib/errors";

const log = createLogger("meta.accounts");

/** Webhook fields we subscribe to per connection mode. Failures are non-fatal. */
const IG_SUBSCRIBED_FIELDS = ["messages", "messaging_postbacks", "messaging_seen", "comments", "mentions"];
const PAGE_SUBSCRIBED_FIELDS = ["messages", "messaging_postbacks", "leadgen"];

export interface ConnectResult {
  accounts: InstagramAccount[];
  warnings: string[];
}

interface IgProfile {
  user_id?: string | number;
  id?: string;
  username: string;
  name?: string;
  account_type?: string;
  profile_picture_url?: string;
  followers_count?: number;
  media_count?: number;
}

/** Finalize a Mode A (Business Login for Instagram) connection. */
export async function finalizeInstagramLogin(code: string): Promise<ConnectResult> {
  const warnings: string[] = [];
  const short = await igExchangeCode(code);
  const long = await igExchangeLongLived(short.accessToken);
  const expiresAt = new Date(Date.now() + long.expiresInSec * 1000);

  const profile = await graphCall<IgProfile>({
    host: "graph.instagram.com",
    path: "me",
    accessToken: long.accessToken,
    params: { fields: "user_id,username,name,account_type,profile_picture_url,followers_count,media_count" },
  });

  const igUserId = String(profile.user_id ?? short.igUserId);
  // Prefer what Instagram actually granted; fall back to what we asked for.
  const scopes = short.permissions.length > 0 ? short.permissions : igLoginScopes();

  const account = await prisma.instagramAccount.upsert({
    where: { igUserId },
    create: {
      igUserId,
      username: profile.username,
      name: profile.name,
      accountType: profile.account_type,
      profilePictureUrl: profile.profile_picture_url,
      followersCount: profile.followers_count,
      mediaCount: profile.media_count,
      connectionMode: "INSTAGRAM_LOGIN",
      status: "CONNECTED",
    },
    update: {
      username: profile.username,
      name: profile.name,
      accountType: profile.account_type,
      profilePictureUrl: profile.profile_picture_url,
      followersCount: profile.followers_count,
      mediaCount: profile.media_count,
      connectionMode: "INSTAGRAM_LOGIN",
      status: "CONNECTED",
    },
  });

  await storeToken({ accountId: account.id, kind: "user", token: long.accessToken, scopes, expiresAt });
  await syncPermissions(account.id, scopes);

  // Webhook subscription (non-fatal)
  try {
    await graphCall({
      host: "graph.instagram.com",
      method: "POST",
      path: `${igUserId}/subscribed_apps`,
      accessToken: long.accessToken,
      params: { subscribed_fields: IG_SUBSCRIBED_FIELDS.join(",") },
    });
    await prisma.instagramAccount.update({ where: { id: account.id }, data: { webhookSubscribed: true } });
  } catch (err) {
    warnings.push(`Webhook subscription failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn("webhook subscribe failed", { accountId: account.id, ...errorFields(err) });
  }

  const fresh = await prisma.instagramAccount.findUniqueOrThrow({ where: { id: account.id } });
  return { accounts: [fresh], warnings };
}

interface FbPage {
  id: string;
  name: string;
  access_token?: string;
}

/**
 * Finalize a Facebook Login connection.
 *
 * This flow exists ONLY to add advertising (Marketing API) to accounts that are
 * already connected. It cannot read Instagram profile data, because the app is
 * configured for Instagram Login and therefore has no instagram_* permissions
 * on the Facebook side — requesting them makes Facebook reject the whole
 * dialog. So instead of discovering Instagram accounts through Pages, it
 * attaches the ad account, Page and ads token to the Instagram accounts the
 * admin has already connected.
 */
export async function finalizeFacebookLogin(code: string): Promise<ConnectResult> {
  const warnings: string[] = [];
  const short = await fbExchangeCode(code);
  const long = await fbExchangeLongLived(short.accessToken);
  const userExpiresAt = new Date(Date.now() + long.expiresInSec * 1000);

  const perms = await graphCall<{ data: Array<{ permission: string; status: string }> }>({
    host: "graph.facebook.com",
    path: "me/permissions",
    accessToken: long.accessToken,
  });
  const grantedScopes = perms.data.filter((p) => p.status === "granted").map((p) => p.permission);

  if (!grantedScopes.includes("ads_management")) {
    throw new AppError("META_PERMISSION_MISSING", "The advertising permission was not granted", {
      reason: "Without ads_management this platform cannot create campaigns, which is the only reason to connect Facebook.",
      fix: "Connect again and leave every permission enabled on the Facebook screen.",
    });
  }

  // The Instagram account(s) that will gain advertising.
  const targets = await prisma.instagramAccount.findMany({
    where: { isDemo: false, status: { not: "DISCONNECTED" } },
  });
  if (targets.length === 0) {
    throw new AppError("VALIDATION", "Connect your Instagram account first", {
      reason: "Advertising is attached to an Instagram account, and none is connected yet.",
      fix: 'Use "Connect Instagram" first, then come back and connect Facebook to enable campaigns.',
    });
  }

  const ads = await graphCall<{ data: Array<{ id: string; account_id: string; name: string; account_status?: number }> }>({
    host: "graph.facebook.com",
    path: "me/adaccounts",
    accessToken: long.accessToken,
    params: { fields: "id,account_id,name,account_status", limit: 25 },
  });
  const adAccount = ads.data?.[0];
  if (!adAccount) {
    throw new AppError("META_UNSUPPORTED", "No ad account found on this Facebook user", {
      reason: "Meta requires an ad account to create campaigns, and this account has none.",
      fix: "Create one at business.facebook.com/settings/ad-accounts, add a payment method, then connect again.",
    });
  }

  let pages: FbPage[] = [];
  try {
    const res = await graphCall<{ data: FbPage[] }>({
      host: "graph.facebook.com",
      path: "me/accounts",
      accessToken: long.accessToken,
      params: { fields: "id,name,access_token", limit: 50 },
    });
    pages = res.data ?? [];
  } catch (err) {
    log.warn("could not list pages", errorFields(err));
  }
  const page = pages[0];
  if (!page) {
    warnings.push(
      "No Facebook Page found. Campaign objectives that need a Page (Leads, Engagement) will stay unavailable until one is linked.",
    );
  } else if (page.access_token) {
    // Subscribe the Page so Instant Form submissions arrive as `leadgen` webhooks
    // instead of having to be polled. Non-fatal: campaigns still work without it.
    try {
      await graphCall({
        host: "graph.facebook.com",
        method: "POST",
        path: `${page.id}/subscribed_apps`,
        accessToken: page.access_token,
        params: { subscribed_fields: PAGE_SUBSCRIBED_FIELDS.join(",") },
      });
      log.info("page subscribed for leadgen webhooks", { pageId: page.id });
    } catch (err) {
      warnings.push("Could not subscribe the Facebook Page to lead webhooks — Instant Form leads will need manual sync.");
      log.warn("page webhook subscribe failed", { pageId: page.id, ...errorFields(err) });
    }
  }

  const accounts: InstagramAccount[] = [];
  for (const target of targets) {
    await prisma.instagramAccount.update({
      where: { id: target.id },
      data: {
        adAccountId: adAccount.id,
        ...(page ? { fbPageId: page.id, fbPageName: page.name } : {}),
      },
    });

    // Stored as "ads" so the Instagram Login token keeps working for messaging.
    await storeToken({
      accountId: target.id,
      kind: "ads",
      token: long.accessToken,
      scopes: grantedScopes,
      expiresAt: userExpiresAt,
    });
    if (page?.access_token) {
      await storeToken({
        accountId: target.id,
        kind: "page",
        token: page.access_token,
        scopes: grantedScopes,
        expiresAt: null,
      });
    }
    await syncPermissions(target.id, grantedScopes);
    accounts.push(await prisma.instagramAccount.findUniqueOrThrow({ where: { id: target.id } }));
  }

  log.info("advertising enabled", { adAccount: adAccount.id, accounts: accounts.length, page: page?.id });
  return { accounts, warnings };
}

async function syncPermissions(accountId: string, scopes: string[]) {
  for (const permission of scopes) {
    await prisma.instagramPermission.upsert({
      where: { accountId_permission: { accountId, permission } },
      create: { accountId, permission, granted: true },
      update: { granted: true, checkedAt: new Date() },
    });
  }
}

/** Live probe used by the "Test Connection" button and health checks. */
export async function testConnection(accountId: string) {
  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId } });
  if (!account) throw notFound("Instagram account");
  const access = await resolveAccess(account);

  try {
    const fields = "id,username,followers_count,media_count";
    const profile =
      account.connectionMode === "INSTAGRAM_LOGIN"
        ? await graphCall<IgProfile>({
            host: "graph.instagram.com",
            path: "me",
            accessToken: access.accessToken,
            params: { fields: "user_id," + fields.replace("id,", "") },
          })
        : await graphCall<IgProfile>({
            host: "graph.facebook.com",
            path: account.igUserId,
            accessToken: access.accessToken,
            params: { fields },
          });

    await prisma.$transaction([
      prisma.instagramAccount.update({
        where: { id: accountId },
        data: {
          status: "CONNECTED",
          username: profile.username ?? account.username,
          followersCount: profile.followers_count ?? account.followersCount,
          mediaCount: profile.media_count ?? account.mediaCount,
        },
      }),
      prisma.instagramToken.update({ where: { id: access.tokenRow.id }, data: { lastCheckedAt: new Date() } }),
    ]);
    return { ok: true as const, username: profile.username, followers: profile.followers_count ?? null };
  } catch (err) {
    if (err instanceof MetaApiError && err.isTokenError) {
      await markTokenExpired(access.tokenRow.id);
      await prisma.instagramAccount.update({ where: { id: accountId }, data: { status: "ERROR" } });
    }
    throw err;
  }
}

/** Disconnect: revoke local tokens, unsubscribe webhooks (best effort). */
export async function disconnectAccount(accountId: string) {
  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId } });
  if (!account) throw notFound("Instagram account");

  try {
    const access = await resolveAccess(account);
    if (account.connectionMode === "INSTAGRAM_LOGIN") {
      await graphCall({
        host: "graph.instagram.com",
        method: "DELETE",
        path: `${account.igUserId}/subscribed_apps`,
        accessToken: access.accessToken,
      });
    } else if (account.fbPageId) {
      await graphCall({
        host: "graph.facebook.com",
        method: "DELETE",
        path: `${account.fbPageId}/subscribed_apps`,
        accessToken: access.accessToken,
      });
    }
  } catch (err) {
    log.warn("unsubscribe during disconnect failed (continuing)", errorFields(err));
  }

  await prisma.$transaction([
    prisma.instagramToken.updateMany({ where: { accountId }, data: { status: "REVOKED" } }),
    prisma.instagramAccount.update({
      where: { id: accountId },
      data: { status: "DISCONNECTED", webhookSubscribed: false },
    }),
  ]);
}

/**
 * Refresh tokens approaching expiry (worker cron).
 *  - Mode A: refreshable in place when ≥24h old and <10 days remaining.
 *  - Mode B: user tokens cannot be silently refreshed — mark for re-auth.
 */
export async function refreshExpiringTokens(): Promise<{ refreshed: number; needsReauth: number }> {
  const soon = new Date(Date.now() + 10 * 24 * 3600 * 1000);
  const candidates = await prisma.instagramToken.findMany({
    where: { status: "ACTIVE", kind: "user", expiresAt: { not: null, lt: soon } },
    include: { account: true },
  });

  let refreshed = 0;
  let needsReauth = 0;
  for (const row of candidates) {
    const ageMs = Date.now() - row.issuedAt.getTime();
    if (row.account.connectionMode === "INSTAGRAM_LOGIN" && ageMs > 24 * 3600 * 1000) {
      try {
        const current = await getActiveToken(row.accountId, "user");
        if (!current) continue;
        const fresh = await igRefreshLongLived(current.token);
        await storeToken({
          accountId: row.accountId,
          kind: "user",
          token: fresh.accessToken,
          scopes: row.scopes,
          expiresAt: new Date(Date.now() + fresh.expiresInSec * 1000),
        });
        await prisma.instagramToken.update({ where: { id: row.id }, data: { lastRefreshAt: new Date() } });
        refreshed++;
        log.info("refreshed IG token", { accountId: row.accountId });
      } catch (err) {
        log.error("token refresh failed", { accountId: row.accountId, ...errorFields(err) });
        if (err instanceof MetaApiError && err.isTokenError) {
          await markTokenExpired(row.id);
          await prisma.instagramAccount.update({ where: { id: row.accountId }, data: { status: "ERROR" } });
        }
      }
    } else if (row.account.connectionMode === "FACEBOOK_LOGIN") {
      needsReauth++;
      await prisma.instagramAccount.update({ where: { id: row.accountId }, data: { status: "ERROR" } });
      log.warn("FB user token near expiry — admin must reconnect", { accountId: row.accountId });
    }
  }
  return { refreshed, needsReauth };
}
