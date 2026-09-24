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
  FB_LOGIN_SCOPES,
  IG_OPTIONAL_SCOPES,
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
  await syncPermissions(account.id, scopes, [...igLoginScopes(), ...IG_OPTIONAL_SCOPES]);

  // Webhook subscription is non-fatal: the account is connected either way, and
  // the admin can retry it from the account card without re-authorizing.
  try {
    await subscribeInstagramWebhooks(account.id, igUserId, long.accessToken);
  } catch (err) {
    warnings.push(`Webhook subscription failed: ${err instanceof Error ? err.message : String(err)}`);
    log.warn("webhook subscribe failed", { accountId: account.id, ...errorFields(err) });
  }

  const fresh = await prisma.instagramAccount.findUniqueOrThrow({ where: { id: account.id } });
  return { accounts: [fresh], warnings };
}

/**
 * Subscribe this app to the account's Instagram events (DMs, comments,
 * mentions). Without it the connection looks healthy but nothing ever arrives,
 * so it is also exposed as a standalone retry — webhook setup is the step most
 * likely to fail for reasons outside the authorization itself (app still in
 * Dev Mode, webhook callback URL not verified in the App Dashboard).
 */
export async function subscribeInstagramWebhooks(
  accountId: string,
  igUserId: string,
  accessToken: string,
): Promise<void> {
  await graphCall({
    host: "graph.instagram.com",
    method: "POST",
    path: `${igUserId}/subscribed_apps`,
    accessToken,
    params: { subscribed_fields: IG_SUBSCRIBED_FIELDS.join(",") },
  });
  await prisma.instagramAccount.update({ where: { id: accountId }, data: { webhookSubscribed: true } });
  log.info("instagram webhooks subscribed", { accountId });
}

/** Retry the webhook subscription for an already-connected account. */
export async function resubscribeWebhooks(accountId: string): Promise<void> {
  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId } });
  if (!account) throw notFound("Instagram account");
  if (account.connectionMode !== "INSTAGRAM_LOGIN") {
    throw new AppError("META_UNSUPPORTED", "Event delivery is managed through the Facebook Page for this account", {
      reason: "This account was connected with Facebook Login, where webhooks belong to the Page, not the Instagram user.",
      fix: "Reconnect with Facebook so the Page subscription is refreshed.",
    });
  }
  const access = await resolveAccess(account);
  await subscribeInstagramWebhooks(account.id, account.igUserId, access.accessToken);
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
 *
 * `targetAccountId` (carried in the signed OAuth state) names the account the
 * admin actually clicked. It matters as soon as there is more than one
 * connected account: an ad account is a billing relationship, and silently
 * attaching one to every account would let a campaign be created against the
 * wrong Instagram profile. Without it, the single connected account is used,
 * and with several it is an error rather than a guess.
 */
export async function finalizeFacebookLogin(code: string, targetAccountId?: string): Promise<ConnectResult> {
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

  // The Instagram account that will gain advertising.
  const connected = await prisma.instagramAccount.findMany({
    where: { isDemo: false, status: { not: "DISCONNECTED" } },
  });
  if (connected.length === 0) {
    throw new AppError("VALIDATION", "Connect your Instagram account first", {
      reason: "Advertising is attached to an Instagram account, and none is connected yet.",
      fix: 'Use "Connect Instagram" first, then come back and connect Facebook to enable campaigns.',
    });
  }

  let targets = connected;
  if (targetAccountId) {
    const picked = connected.find((a) => a.id === targetAccountId);
    if (!picked) {
      throw new AppError("VALIDATION", "That Instagram account is no longer connected", {
        reason: "The account this advertising authorization was started for was disconnected in the meantime.",
        fix: "Reconnect the Instagram account, then connect Facebook for advertising again.",
      });
    }
    targets = [picked];
  } else if (connected.length > 1) {
    throw new AppError("VALIDATION", "Choose which account advertising is for", {
      reason: "More than one Instagram account is connected, and this authorization did not say which one it belongs to.",
      fix: 'Start from that account’s own card on the Instagram page and use "Connect Facebook (for ads)" there.',
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
    await syncPermissions(target.id, grantedScopes, FB_LOGIN_SCOPES);
    accounts.push(await prisma.instagramAccount.findUniqueOrThrow({ where: { id: target.id } }));
  }

  log.info("advertising enabled", { adAccount: adAccount.id, accounts: accounts.length, page: page?.id });
  return { accounts, warnings };
}

/**
 * Record what Meta actually grants right now.
 *
 * Meta reports a revocation by simply not listing the permission any more, so
 * anything inside `governs` that is absent from `granted` is flipped to
 * granted:false — otherwise the capability matrix keeps advertising a feature
 * the user took away, and the failure only shows up as a Graph error mid-send.
 * Rows are kept rather than deleted so the history of what was once granted
 * survives a re-authorization.
 *
 * `governs` is per-flow because one account can hold BOTH connections: the
 * Facebook (ads) authorization never reports instagram_* scopes, and treating
 * its response as authoritative over everything would revoke the messaging
 * permissions of the Instagram Login connection.
 */
async function syncPermissions(accountId: string, granted: string[], governs: readonly string[]) {
  const checkedAt = new Date();
  for (const permission of granted) {
    await prisma.instagramPermission.upsert({
      where: { accountId_permission: { accountId, permission } },
      create: { accountId, permission, granted: true },
      update: { granted: true, checkedAt },
    });
  }

  const revoked = governs.filter((p) => !granted.includes(p));
  if (revoked.length === 0) return;
  const { count } = await prisma.instagramPermission.updateMany({
    where: { accountId, permission: { in: revoked }, granted: true },
    data: { granted: false, checkedAt },
  });
  if (count > 0) log.warn("permissions no longer granted at Meta", { accountId, revoked });
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

/** Lead time on tokens Meta will not refresh, for both the sweep and re-auth warnings. */
const REAUTH_WARNING_MS = 10 * 24 * 3600 * 1000;

/**
 * Refresh tokens approaching expiry (worker cron).
 *  - Mode A: refreshable in place when ≥24h old and <10 days remaining.
 *  - Mode B: user tokens cannot be silently refreshed — mark for re-auth.
 *  - Facebook ads/page tokens: same, and reported separately because losing
 *    them costs advertising only, not messaging.
 */
export async function refreshExpiringTokens(): Promise<{
  refreshed: number;
  needsReauth: number;
  adsNeedsReconnect: number;
}> {
  const soon = new Date(Date.now() + REAUTH_WARNING_MS);
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
  return { refreshed, needsReauth, adsNeedsReconnect: await flagExpiringFacebookTokens() };
}

/**
 * Advertising rides on the Facebook token stored as kind "ads" (and the Page
 * token beside it), which Meta gives no way to refresh — ig_refresh_token is
 * Instagram-only, and a long-lived Facebook user token simply dies ~60 days
 * after the admin authorized it. So this does not pretend to renew anything: a
 * token that is already past its expiry is marked EXPIRED, which turns the ads
 * capability off with a reconnect reason instead of letting a campaign fail
 * mid-publish; one still inside the warning window is left working and only
 * warned about, with lastCheckedAt stamped so the token list shows when the
 * sweep last looked at it. The deadline the account card shows is derived from
 * expiresAt, not from anything written here.
 *
 * The Instagram Login token is untouched — reconnecting Facebook must never be
 * required to keep answering DMs.
 */
async function flagExpiringFacebookTokens(): Promise<number> {
  const rows = await prisma.instagramToken.findMany({
    where: {
      status: "ACTIVE",
      kind: { in: ["ads", "page"] },
      expiresAt: { not: null, lt: new Date(Date.now() + REAUTH_WARNING_MS) },
    },
    select: { id: true, accountId: true, kind: true, expiresAt: true },
  });

  const now = Date.now();
  for (const row of rows) {
    const expiresAt = row.expiresAt;
    if (!expiresAt) continue;
    if (expiresAt.getTime() <= now) {
      await markTokenExpired(row.id);
      log.warn("facebook token expired — advertising needs a reconnect", {
        accountId: row.accountId,
        kind: row.kind,
      });
    } else {
      await prisma.instagramToken.update({ where: { id: row.id }, data: { lastCheckedAt: new Date() } });
      log.warn("facebook token near expiry and cannot be refreshed — admin must reconnect Facebook", {
        accountId: row.accountId,
        kind: row.kind,
        expiresAt: expiresAt.toISOString(),
        daysLeft: Math.floor((expiresAt.getTime() - now) / (24 * 3600 * 1000)),
      });
    }
  }
  return rows.length;
}
