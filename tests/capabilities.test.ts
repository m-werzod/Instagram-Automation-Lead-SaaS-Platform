import { describe, expect, it } from "vitest";
import { capabilityMap, detectCapabilities, type AccountWithAuth } from "@/lib/meta/capabilities";

function account(overrides: Partial<AccountWithAuth>): AccountWithAuth {
  return {
    id: "a1",
    igUserId: "178",
    username: "biz",
    name: null,
    accountType: "BUSINESS",
    profilePictureUrl: null,
    followersCount: null,
    mediaCount: null,
    connectionMode: "INSTAGRAM_LOGIN",
    fbPageId: null,
    fbPageName: null,
    adAccountId: null,
    status: "CONNECTED",
    webhookSubscribed: true,
    lastSyncAt: null,
    isDemo: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    permissions: [],
    tokens: [],
    ...overrides,
  } as AccountWithAuth;
}

function token(kind: "user" | "page" | "ads", scopes: string[], expiresAt: Date | null = null) {
  return {
    id: "t1",
    accountId: "a1",
    kind,
    encrypted: "x",
    status: "ACTIVE",
    scopes,
    issuedAt: new Date(),
    expiresAt,
    lastRefreshAt: null,
    lastCheckedAt: null,
  } as AccountWithAuth["tokens"][number];
}

describe("capability detection", () => {
  it("mode A with full scopes: organic caps available, ads unavailable with mode reason", () => {
    const caps = capabilityMap(
      detectCapabilities(
        account({
          tokens: [
            token("user", [
              "instagram_business_basic",
              "instagram_business_manage_messages",
              "instagram_business_manage_comments",
              "instagram_business_content_publish",
              "instagram_business_manage_insights",
            ]),
          ],
        }),
      ),
    );
    expect(caps.messaging.available).toBe(true);
    expect(caps.publishing.available).toBe(true);
    expect(caps.comments.available).toBe(true);
    expect(caps.insights.available).toBe(true);
    // Organic features work, but advertising needs the separate Facebook
    // authorization — it is not implied by how Instagram was connected.
    expect(caps.ads.available).toBe(false);
    expect(caps.ads.reason).toContain("Connect with Facebook (ads)");
    expect(caps.lead_forms.available).toBe(false);
  });

  it("Instagram-Login account gains ads once the Facebook (ads) token + ad account exist", () => {
    const caps = capabilityMap(
      detectCapabilities(
        account({
          adAccountId: "act_123456",
          fbPageId: "9876",
          tokens: [
            token("user", ["instagram_business_basic", "instagram_business_manage_messages"]),
            token("ads", ["ads_management", "ads_read", "leads_retrieval", "pages_manage_ads"]),
          ],
        }),
      ),
    );
    // Messaging still works — the ads token must never displace the IG token.
    expect(caps.messaging.available).toBe(true);
    expect(caps.ads.available).toBe(true);
    expect(caps.ads.reason).toBeUndefined();
    expect(caps.lead_forms.available).toBe(true);
  });

  it("ads token present but no ad account → unavailable, and says so", () => {
    const caps = capabilityMap(
      detectCapabilities(
        account({
          adAccountId: null,
          tokens: [
            token("user", ["instagram_business_basic"]),
            token("ads", ["ads_management"]),
          ],
        }),
      ),
    );
    expect(caps.ads.available).toBe(false);
    expect(caps.ads.reason).toContain("ad account");
  });

  it("missing messaging scope → messaging unavailable with scope reason", () => {
    const caps = capabilityMap(
      detectCapabilities(account({ tokens: [token("user", ["instagram_business_basic"])] })),
    );
    expect(caps.messaging.available).toBe(false);
    expect(caps.messaging.reason).toContain("permission");
  });

  it("expired token → everything token-dependent unavailable", () => {
    const caps = capabilityMap(
      detectCapabilities(
        account({
          tokens: [token("user", ["instagram_business_manage_messages"], new Date(Date.now() - 1000))],
        }),
      ),
    );
    expect(caps.messaging.available).toBe(false);
    expect(caps.messaging.reason).toContain("token");
  });

  it("mode B with ads scopes + ad account + page → ads and lead forms available", () => {
    const caps = capabilityMap(
      detectCapabilities(
        account({
          connectionMode: "FACEBOOK_LOGIN",
          fbPageId: "p1",
          adAccountId: "act_1",
          tokens: [
            token("user", ["instagram_basic", "ads_management", "leads_retrieval", "pages_manage_ads"]),
            token("page", ["instagram_manage_messages"]),
          ],
        }),
      ),
    );
    expect(caps.ads.available).toBe(true);
    expect(caps.lead_forms.available).toBe(true);
    expect(caps.messaging.available).toBe(true);
  });

  it("mode B without selected ad account → ads unavailable with actionable reason", () => {
    const caps = capabilityMap(
      detectCapabilities(
        account({
          connectionMode: "FACEBOOK_LOGIN",
          fbPageId: "p1",
          adAccountId: null,
          tokens: [token("user", ["ads_management"]), token("page", [])],
        }),
      ),
    );
    expect(caps.ads.available).toBe(false);
    expect(caps.ads.reason).toContain("ad account");
  });

  it("webhooks capability mirrors subscription flag", () => {
    const caps = capabilityMap(detectCapabilities(account({ webhookSubscribed: false, tokens: [token("user", [])] })));
    expect(caps.webhooks.available).toBe(false);
  });
});
