import { createHmac } from "crypto";
import { coreEnv, instagramAppCredentials, metaEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { MetaApiError, type MetaErrorBody } from "./client";

/**
 * Dual OAuth flows — see docs/META_API.md §1–2.
 *  Mode A: Business Login for Instagram (instagram.com/oauth/authorize)
 *  Mode B: Facebook Login for Business  (facebook.com/{v}/dialog/oauth)
 */

export type ConnectMode = "INSTAGRAM_LOGIN" | "FACEBOOK_LOGIN";

/**
 * Instagram Login scopes (names renamed 2025-01-27; the old business_basic
 * style is dead).
 *
 * Only the three permissions Meta lists as REQUIRED for the Instagram API use
 * case are requested by default. Instagram rejects the whole authorization with
 * "Invalid Scopes" if any single requested permission is not enabled on the
 * app, and content publishing / insights are OPTIONAL extras that an app does
 * not have until they are explicitly added in the dashboard. Requesting them
 * unconditionally would break the connection for every new installation.
 *
 * Enable the extras once they are added under Instagram → Permissions and
 * features, via META_INSTAGRAM_EXTRA_SCOPES (comma-separated). Anything not
 * granted simply shows as unavailable in the capability matrix.
 */
export const IG_REQUIRED_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_messages",
  "instagram_business_manage_comments",
] as const;

export const IG_OPTIONAL_SCOPES = [
  "instagram_business_content_publish",
  "instagram_business_manage_insights",
] as const;

export function igLoginScopes(): string[] {
  const extra = (process.env.META_INSTAGRAM_EXTRA_SCOPES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...IG_REQUIRED_SCOPES, ...extra])];
}

/** @deprecated kept for callers that only need the baseline set */
export const IG_LOGIN_SCOPES = IG_REQUIRED_SCOPES;

/**
 * Facebook Login is used for ONE job here: advertising (Marketing API).
 *
 * It deliberately does NOT request instagram_basic / instagram_manage_* /
 * pages_manage_metadata. Those belong to the older "Instagram API with Facebook
 * Login" product; an app configured for Instagram Login does not have them, and
 * Facebook rejects the ENTIRE authorization dialog with "Invalid Scopes" if any
 * single unavailable permission is requested. Organic features (messages,
 * comments, publishing, insights) come from the Instagram Login connection.
 */
export const FB_LOGIN_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "business_management",
  "ads_management",
  "ads_read",
  "pages_manage_ads",
  "leads_retrieval",
] as const;

// ---- signed state (CSRF for the OAuth dance) ------------------------------

interface OAuthStatePayload {
  mode: ConnectMode;
  adminId: string;
  nonce: string;
  ts: number;
  /**
   * FACEBOOK_LOGIN only: the Instagram account this advertising authorization
   * belongs to. Carried through the round trip because Facebook gives us no way
   * to know which card the admin clicked, and attaching an ad account to the
   * wrong Instagram account is silent and expensive. Absent on older links and
   * on single-account installs, where "the only account" is unambiguous.
   */
  accountId?: string;
  /**
   * Set when the authorization was started from a connect INVITATION rather
   * than by a signed-in admin — i.e. the person at the keyboard is the
   * Instagram account owner, who has no account here at all. The callback
   * validates this invite instead of demanding an admin session; `adminId`
   * then names the admin who issued the link, purely for the audit trail.
   */
  inviteId?: string;
}

function sign(data: string): string {
  return createHmac("sha256", coreEnv().SESSION_SECRET).update(data).digest("base64url");
}

export function buildState(payload: Omit<OAuthStatePayload, "ts">): string {
  const body = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString("base64url");
  return `${body}.${sign(body)}`;
}

const STATE_MAX_AGE_MS = 15 * 60 * 1000;

export function verifyState(state: string): OAuthStatePayload {
  const [body, sig] = state.split(".");
  if (!body || !sig || sign(body) !== sig) {
    throw new AppError("META_AUTH_FAILED", "OAuth state validation failed", {
      reason: "The state parameter was missing, altered, or not issued by this server.",
      fix: "Start the connection again from Settings → Integrations → Instagram.",
    });
  }
  const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as OAuthStatePayload;
  if (Date.now() - payload.ts > STATE_MAX_AGE_MS) {
    throw new AppError("META_AUTH_FAILED", "OAuth state expired", {
      reason: "More than 15 minutes passed since the connection was started.",
      fix: "Start the connection again.",
    });
  }
  return payload;
}

// ---- authorize URLs --------------------------------------------------------

/**
 * @param forceReauth Ask Instagram to sign the person in again instead of
 *   silently reusing the browser's current Instagram session. Required to
 *   connect a SECOND account: without it Instagram just re-approves whoever is
 *   already logged in, so "Add another account" would keep re-connecting the
 *   same one.
 */
export function instagramAuthorizeUrl(state: string, forceReauth = false): string {
  const env = metaEnv();
  // NOTE: Instagram Login uses the INSTAGRAM app id, not the Facebook one.
  const { appId } = instagramAppCredentials();
  const url = new URL("https://www.instagram.com/oauth/authorize");
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", env.META_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", igLoginScopes().join(","));
  url.searchParams.set("state", state);
  if (forceReauth) url.searchParams.set("force_reauth", "true");
  return url.toString();
}

export function facebookAuthorizeUrl(state: string): string {
  const env = metaEnv();
  const url = new URL(`https://www.facebook.com/${env.META_GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", env.META_APP_ID);
  url.searchParams.set("redirect_uri", env.META_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", FB_LOGIN_SCOPES.join(","));
  url.searchParams.set("state", state);
  return url.toString();
}

// ---- token exchanges -------------------------------------------------------

async function postForm<T>(url: string, form: Record<string, string>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: MetaErrorBody | string; error_message?: string };
  if (!res.ok || json.error || json.error_message) {
    const err = json.error;
    if (err && typeof err === "object") throw new MetaApiError(err, res.status);
    throw new AppError("META_AUTH_FAILED", String(json.error_message ?? err ?? `HTTP ${res.status}`), {
      reason: "Meta rejected the token exchange.",
      fix: "Verify META_APP_ID/META_APP_SECRET/META_REDIRECT_URI match the App Dashboard exactly.",
    });
  }
  return json as T;
}

async function getJson<T>(url: URL): Promise<T> {
  const res = await fetch(url);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: MetaErrorBody };
  if (!res.ok || json.error) {
    throw new MetaApiError(json.error ?? { message: `HTTP ${res.status}` }, res.status);
  }
  return json as T;
}

export interface IgShortTokenResult {
  accessToken: string;
  igUserId: string;
  permissions: string[];
}

/** Mode A step 1: code → short-lived token (api.instagram.com). */
export async function igExchangeCode(code: string): Promise<IgShortTokenResult> {
  const env = metaEnv();
  type Shape = {
    access_token?: string;
    user_id?: number | string;
    permissions?: string[] | string;
    data?: Array<{ access_token: string; user_id: number | string; permissions?: string[] | string }>;
  };
  const { appId, appSecret } = instagramAppCredentials();
  const json = await postForm<Shape>("https://api.instagram.com/oauth/access_token", {
    client_id: appId,
    client_secret: appSecret,
    grant_type: "authorization_code",
    redirect_uri: env.META_REDIRECT_URI,
    code,
  });
  // Meta has shipped both {access_token,...} and {data:[{...}]} shapes — accept both.
  const entry = json.data?.[0] ?? json;
  if (!entry.access_token || entry.user_id === undefined) {
    throw new AppError("META_AUTH_FAILED", "Unexpected token response from Instagram", {
      reason: "Response did not include access_token/user_id.",
    });
  }
  const permissions = Array.isArray(entry.permissions)
    ? entry.permissions
    : typeof entry.permissions === "string"
      ? entry.permissions.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  return { accessToken: entry.access_token, igUserId: String(entry.user_id), permissions };
}

export interface LongLivedToken {
  accessToken: string;
  expiresInSec: number;
}

/** Mode A step 2: short-lived → long-lived (~60 days). */
export async function igExchangeLongLived(shortToken: string): Promise<LongLivedToken> {
  const { appSecret } = instagramAppCredentials();
  const url = new URL("https://graph.instagram.com/access_token");
  url.searchParams.set("grant_type", "ig_exchange_token");
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("access_token", shortToken);
  const json = await getJson<{ access_token: string; expires_in: number }>(url);
  return { accessToken: json.access_token, expiresInSec: json.expires_in };
}

/** Mode A refresh: long-lived token ≥24h old → fresh 60-day token. */
export async function igRefreshLongLived(longToken: string): Promise<LongLivedToken> {
  const url = new URL("https://graph.instagram.com/refresh_access_token");
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", longToken);
  const json = await getJson<{ access_token: string; expires_in: number }>(url);
  return { accessToken: json.access_token, expiresInSec: json.expires_in };
}

/** Mode B step 1: code → user token. */
export async function fbExchangeCode(code: string): Promise<LongLivedToken> {
  const env = metaEnv();
  const url = new URL(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set("client_id", env.META_APP_ID);
  url.searchParams.set("client_secret", env.META_APP_SECRET);
  url.searchParams.set("redirect_uri", env.META_REDIRECT_URI);
  url.searchParams.set("code", code);
  const json = await getJson<{ access_token: string; expires_in?: number }>(url);
  return { accessToken: json.access_token, expiresInSec: json.expires_in ?? 3600 };
}

/** Mode B step 2: short user token → long-lived (~60 days). */
export async function fbExchangeLongLived(shortToken: string): Promise<LongLivedToken> {
  const env = metaEnv();
  const url = new URL(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", env.META_APP_ID);
  url.searchParams.set("client_secret", env.META_APP_SECRET);
  url.searchParams.set("fb_exchange_token", shortToken);
  const json = await getJson<{ access_token: string; expires_in?: number }>(url);
  return { accessToken: json.access_token, expiresInSec: json.expires_in ?? 60 * 24 * 3600 };
}
