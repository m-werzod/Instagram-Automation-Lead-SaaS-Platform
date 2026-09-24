import type { InstagramAccount, InstagramPermission, InstagramToken } from "@prisma/client";

/**
 * Capability detection (spec §40). The UI never hardcodes "everything
 * enabled" — each feature's availability is derived from connection mode,
 * granted scopes, token health and account linkage, with a human-readable
 * reason when unavailable.
 */

export type CapabilityKey =
  | "messaging"
  | "publishing"
  | "comments"
  | "insights"
  | "ads"
  | "lead_forms"
  | "webhooks";

export interface Capability {
  key: CapabilityKey;
  label: string;
  available: boolean;
  reason?: string;
  /** Still working, but about to stop unless the admin acts. */
  warning?: string;
}

export interface AccountWithAuth extends InstagramAccount {
  permissions: InstagramPermission[];
  tokens: InstagramToken[];
}

/**
 * A permission row is Meta's own answer at the last authorization, which
 * syncPermissions keeps current in BOTH directions; a token's `scopes` is only
 * the snapshot taken when that token was issued. So an explicitly revoked
 * permission outranks the scope list — an ACTIVE token left over from an
 * earlier authorization (the Page token is only re-stored when Meta returns a
 * Page) would otherwise keep a feature lit up after the user took the scope
 * away, and the loss would only surface as a Graph error mid-send.
 */
function hasScope(acc: AccountWithAuth, ...names: string[]): boolean {
  const revoked = new Set(acc.permissions.filter((p) => !p.granted).map((p) => p.permission));
  const granted = new Set([
    ...acc.permissions.filter((p) => p.granted).map((p) => p.permission),
    ...acc.tokens.filter((t) => t.status === "ACTIVE").flatMap((t) => t.scopes),
  ]);
  return names.some((n) => granted.has(n) && !revoked.has(n));
}

function tokenLive(t: InstagramToken): boolean {
  return t.status === "ACTIVE" && (!t.expiresAt || t.expiresAt.getTime() > Date.now());
}

function activeToken(acc: AccountWithAuth, kind: "user" | "page" | "ads"): boolean {
  return acc.tokens.some((t) => t.kind === kind && tokenLive(t));
}

/** How long before an unrenewable Facebook token dies the admin is told to reconnect. */
const ADS_REAUTH_WARNING_MS = 10 * 24 * 3600 * 1000;

/**
 * The Facebook token advertising actually runs on, picked in the same order
 * resolveAdsAccess() picks one at call time: the dedicated "ads" token, else the
 * plain user token of an account connected entirely through Facebook Login,
 * live before lapsed. A lapsed row is returned only when nothing live remains,
 * because "the Facebook connection expired" and "Facebook was never connected"
 * need different advice and look identical from the availability flag alone —
 * and a deadline read off a row advertising is NOT using would announce a date
 * that has already passed.
 */
function adsTokenRow(acc: AccountWithAuth, modeA: boolean): InstagramToken | null {
  const newest = (rows: InstagramToken[]) => rows.sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime())[0] ?? null;
  const ads = acc.tokens.filter((t) => t.kind === "ads");
  const user = modeA ? [] : acc.tokens.filter((t) => t.kind === "user");
  return newest(ads.filter(tokenLive)) ?? newest(user.filter(tokenLive)) ?? newest(ads) ?? newest(user);
}

export function detectCapabilities(acc: AccountWithAuth): Capability[] {
  const modeA = acc.connectionMode === "INSTAGRAM_LOGIN";
  const tokenOk = modeA ? activeToken(acc, "user") : activeToken(acc, "page");
  const caps: Capability[] = [];

  const noToken = "Access token expired or revoked — reconnect the account.";

  caps.push({
    key: "messaging",
    label: "Messaging",
    available: tokenOk && hasScope(acc, "instagram_business_manage_messages", "instagram_manage_messages"),
    reason: !tokenOk
      ? noToken
      : hasScope(acc, "instagram_business_manage_messages", "instagram_manage_messages")
        ? undefined
        : "The messaging permission was not granted during authorization.",
  });

  caps.push({
    key: "publishing",
    label: "Content Publishing",
    available: tokenOk && hasScope(acc, "instagram_business_content_publish", "instagram_content_publish"),
    reason: !tokenOk
      ? noToken
      : hasScope(acc, "instagram_business_content_publish", "instagram_content_publish")
        ? undefined
        : "The content publishing permission was not granted.",
  });

  caps.push({
    key: "comments",
    label: "Comments",
    available: tokenOk && hasScope(acc, "instagram_business_manage_comments", "instagram_manage_comments"),
    reason: !tokenOk
      ? noToken
      : hasScope(acc, "instagram_business_manage_comments", "instagram_manage_comments")
        ? undefined
        : "The comments permission was not granted.",
  });

  caps.push({
    key: "insights",
    label: "Insights",
    available: tokenOk && hasScope(acc, "instagram_business_manage_insights", "instagram_manage_insights"),
    reason: !tokenOk
      ? noToken
      : hasScope(acc, "instagram_business_manage_insights", "instagram_manage_insights")
        ? undefined
        : "The insights permission was not granted.",
  });

  // Advertising is independent of how Instagram itself was connected: it needs
  // an ads-capable Facebook token plus an ad account, both supplied by the
  // separate "Connect with Facebook (ads)" authorization.
  const adsTokenOk = activeToken(acc, "ads") || (!modeA && activeToken(acc, "user"));
  const adsScopes = hasScope(acc, "ads_management");
  const adsToken = adsTokenRow(acc, modeA);
  // Meta has no refresh grant for the Facebook token: it dies ~60 days after
  // the authorization and only a reconnect brings advertising back, so the
  // deadline is surfaced while campaigns still run, and a lapsed connection is
  // named as lapsed instead of as "never connected".
  const adsLapsed = !adsTokenOk && adsToken !== null;
  const adsExpiresAt =
    adsTokenOk && adsToken?.expiresAt && adsToken.expiresAt.getTime() - Date.now() < ADS_REAUTH_WARNING_MS
      ? adsToken.expiresAt
      : null;
  const adsWarning = adsExpiresAt
    ? `Facebook access for advertising expires on ${adsExpiresAt.toISOString().slice(0, 10)} and Meta cannot renew it automatically. Reconnect Facebook before then to keep campaigns and lead forms running; messaging is unaffected.`
    : undefined;
  const adsLapsedReason =
    "The Facebook connection for advertising expired or was revoked. Use 'Connect with Facebook (ads)' again to restore campaigns — messaging keeps working meanwhile.";

  // A deadline only means something on a feature that is running today: on an
  // unavailable one it would read as a second, contradictory explanation next to
  // the reason it is off.
  const adsAvailable = adsTokenOk && adsScopes && Boolean(acc.adAccountId);
  caps.push({
    key: "ads",
    label: "Advertising (Campaigns)",
    available: adsAvailable,
    reason: adsAvailable
      ? undefined
      : adsLapsed
        ? adsLapsedReason
        : !adsScopes || !adsTokenOk
          ? "Advertising is not connected yet. Use 'Connect with Facebook (ads)' on the Integrations page — it adds campaigns to this account without affecting messaging."
          : "No ad account is linked. Create one in Meta Business settings, then reconnect Facebook.",
    warning: adsAvailable ? adsWarning : undefined,
  });

  const leadScopes = hasScope(acc, "leads_retrieval") && hasScope(acc, "pages_manage_ads");
  const leadFormsAvailable = adsTokenOk && leadScopes && Boolean(acc.fbPageId);
  caps.push({
    key: "lead_forms",
    label: "Lead Forms (Instant Forms)",
    available: leadFormsAvailable,
    reason: leadFormsAvailable
      ? undefined
      : adsLapsed
        ? adsLapsedReason
        : !adsTokenOk || !leadScopes
          ? "Requires the Facebook (ads) connection with lead permissions granted."
          : "No Facebook Page is linked — Instant Forms belong to a Page.",
    warning: leadFormsAvailable ? adsWarning : undefined,
  });

  caps.push({
    key: "webhooks",
    label: "Webhooks (real-time events)",
    available: acc.webhookSubscribed,
    reason: acc.webhookSubscribed
      ? undefined
      : "Webhook subscription not active. Check the app dashboard webhook config and that the app is Live (or the account holder is an app tester in Dev Mode).",
  });

  return caps;
}

export function capabilityMap(caps: Capability[]): Record<CapabilityKey, Capability> {
  return Object.fromEntries(caps.map((c) => [c.key, c])) as Record<CapabilityKey, Capability>;
}
