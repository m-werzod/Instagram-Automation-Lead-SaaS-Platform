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
}

export interface AccountWithAuth extends InstagramAccount {
  permissions: InstagramPermission[];
  tokens: InstagramToken[];
}

function hasScope(acc: AccountWithAuth, ...names: string[]): boolean {
  const granted = new Set([
    ...acc.permissions.filter((p) => p.granted).map((p) => p.permission),
    ...acc.tokens.filter((t) => t.status === "ACTIVE").flatMap((t) => t.scopes),
  ]);
  return names.some((n) => granted.has(n));
}

function activeToken(acc: AccountWithAuth, kind: "user" | "page" | "ads"): boolean {
  return acc.tokens.some(
    (t) => t.kind === kind && t.status === "ACTIVE" && (!t.expiresAt || t.expiresAt.getTime() > Date.now()),
  );
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
  caps.push({
    key: "ads",
    label: "Advertising (Campaigns)",
    available: adsTokenOk && adsScopes && Boolean(acc.adAccountId),
    reason:
      adsTokenOk && adsScopes && acc.adAccountId
        ? undefined
        : !adsScopes || !adsTokenOk
          ? "Advertising is not connected yet. Use 'Connect with Facebook (ads)' on the Integrations page — it adds campaigns to this account without affecting messaging."
          : "No ad account is linked. Create one in Meta Business settings, then reconnect Facebook.",
  });

  const leadScopes = hasScope(acc, "leads_retrieval") && hasScope(acc, "pages_manage_ads");
  caps.push({
    key: "lead_forms",
    label: "Lead Forms (Instant Forms)",
    available: adsTokenOk && leadScopes && Boolean(acc.fbPageId),
    reason:
      adsTokenOk && leadScopes && acc.fbPageId
        ? undefined
        : !adsTokenOk || !leadScopes
          ? "Requires the Facebook (ads) connection with lead permissions granted."
          : "No Facebook Page is linked — Instant Forms belong to a Page.",
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
