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

function activeToken(acc: AccountWithAuth, kind: "user" | "page"): boolean {
  return acc.tokens.some(
    (t) => t.kind === kind && t.status === "ACTIVE" && (!t.expiresAt || t.expiresAt.getTime() > Date.now()),
  );
}

export function detectCapabilities(acc: AccountWithAuth): Capability[] {
  const modeA = acc.connectionMode === "INSTAGRAM_LOGIN";
  const tokenOk = modeA ? activeToken(acc, "user") : activeToken(acc, "page");
  const userTokenOk = activeToken(acc, "user");
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

  const adsScopes = hasScope(acc, "ads_management");
  caps.push({
    key: "ads",
    label: "Advertising (Campaigns)",
    available: !modeA && userTokenOk && adsScopes && Boolean(acc.adAccountId),
    reason: modeA
      ? "Advertising requires the Facebook Login connection mode (Marketing API). Reconnect via 'Connect with Facebook (ads)'."
      : !userTokenOk
        ? noToken
        : !adsScopes
          ? "The ads_management permission was not granted."
          : !acc.adAccountId
            ? "No ad account selected — choose one in the account settings."
            : undefined,
  });

  const leadScopes = hasScope(acc, "leads_retrieval") && hasScope(acc, "pages_manage_ads");
  caps.push({
    key: "lead_forms",
    label: "Lead Forms (Instant Forms)",
    available: !modeA && userTokenOk && leadScopes && Boolean(acc.fbPageId),
    reason: modeA
      ? "Instant Forms are a Meta lead-ads product and require the Facebook Login mode."
      : !userTokenOk
        ? noToken
        : !leadScopes
          ? "leads_retrieval / pages_manage_ads permissions were not granted."
          : !acc.fbPageId
            ? "No linked Facebook Page found."
            : undefined,
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
