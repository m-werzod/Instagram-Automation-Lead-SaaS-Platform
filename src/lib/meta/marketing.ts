import type { Campaign, InstagramAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError, metaUnsupported } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { graphCall } from "./client";
import { resolveAdsAccess } from "./tokens";

const log = createLogger("meta.marketing");

/**
 * Marketing API integration (docs/META_API.md §8).
 * HARD SAFETY RULES:
 *  - everything is created with status=PAUSED,
 *  - activation (real spend) only via publishCampaign(), which the API layer
 *    gates behind explicit admin confirmation + audit (spec §16).
 * Only vetted, verified CTA types and objectives are exposed.
 */

export const SUPPORTED_OBJECTIVES = [
  { value: "OUTCOME_TRAFFIC", label: "Traffic (website clicks)" },
  { value: "OUTCOME_ENGAGEMENT", label: "Engagement (incl. Instagram Direct)" },
  { value: "OUTCOME_LEADS", label: "Leads (Instant Forms)" },
  { value: "OUTCOME_AWARENESS", label: "Awareness (reach)" },
] as const;

/** Verified subset of Meta's call_to_action enum, valid for IG placements. */
export const SUPPORTED_CTA_TYPES = [
  { value: "LEARN_MORE", label: "Learn More" },
  { value: "SIGN_UP", label: "Sign Up" },
  { value: "CONTACT_US", label: "Contact Us" },
  { value: "GET_QUOTE", label: "Get Quote" },
  { value: "SUBSCRIBE", label: "Subscribe" },
  { value: "BOOK_NOW", label: "Book Now" },
  { value: "APPLY_NOW", label: "Apply Now" },
  { value: "SHOP_NOW", label: "Shop Now" },
  { value: "DOWNLOAD", label: "Download" },
  { value: "MESSAGE_PAGE", label: "Send Message" },
] as const;

export const INSTAGRAM_POSITIONS = ["stream", "story", "explore", "reels"] as const;

interface ObjectiveConfig {
  optimizationGoal: string;
  billingEvent: string;
  destinationType?: string;
  needsPage: boolean;
}

const OBJECTIVE_CONFIG: Record<string, ObjectiveConfig> = {
  OUTCOME_TRAFFIC: { optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS", needsPage: false },
  OUTCOME_ENGAGEMENT: {
    optimizationGoal: "CONVERSATIONS",
    billingEvent: "IMPRESSIONS",
    destinationType: "INSTAGRAM_DIRECT",
    needsPage: true,
  },
  OUTCOME_LEADS: {
    optimizationGoal: "LEAD_GENERATION",
    billingEvent: "IMPRESSIONS",
    destinationType: "ON_AD",
    needsPage: true,
  },
  OUTCOME_AWARENESS: { optimizationGoal: "REACH", billingEvent: "IMPRESSIONS", needsPage: true },
};

export interface CampaignTargeting {
  countries?: string[];
  ageMin?: number;
  ageMax?: number;
  genders?: number[]; // 1 = male, 2 = female (Meta convention); empty = all
  instagramPositions?: string[];
}

export function assertAdsCapable(account: InstagramAccount): void {
  if (account.connectionMode !== "FACEBOOK_LOGIN") {
    throw metaUnsupported(
      "Campaigns",
      "The Marketing API requires the Facebook Login connection mode; this account was connected with Instagram Login.",
      "Reconnect this account via 'Connect with Facebook (ads)' in Settings → Integrations → Instagram.",
    );
  }
  if (!account.adAccountId) {
    throw metaUnsupported("Campaigns", "No ad account is linked to this Instagram account.", "Select an ad account in the account settings.");
  }
}

function buildTargeting(t: CampaignTargeting | null): Record<string, unknown> {
  const targeting: Record<string, unknown> = {
    geo_locations: { countries: t?.countries?.length ? t.countries : ["US"] },
    publisher_platforms: ["instagram"],
    instagram_positions: t?.instagramPositions?.length ? t.instagramPositions : ["stream", "reels"],
    // explicit choice, not Meta's default expansion — predictable targeting
    targeting_automation: { advantage_audience: 0 },
  };
  if (t?.ageMin) targeting.age_min = Math.max(18, t.ageMin);
  if (t?.ageMax) targeting.age_max = Math.min(65, t.ageMax);
  if (t?.genders?.length) targeting.genders = t.genders;
  return targeting;
}

export interface MetaCampaignIds {
  metaCampaignId: string;
  metaAdSetId: string;
  metaCreativeId: string;
  metaAdId: string;
}

/**
 * Create the full campaign→adset→creative→ad chain in Meta, ALL PAUSED.
 * Local Campaign row must already exist (status DRAFT/READY).
 */
export async function createCampaignInMeta(account: InstagramAccount, campaign: Campaign): Promise<MetaCampaignIds> {
  assertAdsCapable(account);
  const access = await resolveAdsAccess(account);
  const adAccount = account.adAccountId!; // "act_..."
  const config = OBJECTIVE_CONFIG[campaign.objective];
  if (!config) {
    throw new AppError("VALIDATION", `Objective ${campaign.objective} is not supported`, {
      fix: `Use one of: ${SUPPORTED_OBJECTIVES.map((o) => o.value).join(", ")}`,
    });
  }
  if (config.needsPage && !account.fbPageId) {
    throw metaUnsupported("This campaign objective", "It requires a linked Facebook Page.", "Reconnect via Facebook Login.");
  }
  if (!campaign.dailyBudgetCents && !campaign.lifetimeBudgetCents) {
    throw new AppError("VALIDATION", "Campaign needs a daily or lifetime budget");
  }

  // 1. Campaign (PAUSED)
  const camp = await graphCall<{ id: string }>({
    host: "graph.facebook.com",
    method: "POST",
    path: `${adAccount}/campaigns`,
    accessToken: access.accessToken,
    body: {
      name: campaign.name,
      objective: campaign.objective,
      status: "PAUSED",
      special_ad_categories: [],
    },
  });

  // 2. Ad set (PAUSED)
  const targeting = buildTargeting(campaign.targeting as CampaignTargeting | null);
  const adsetBody: Record<string, unknown> = {
    name: `${campaign.name} — ad set`,
    campaign_id: camp.id,
    status: "PAUSED",
    billing_event: config.billingEvent,
    optimization_goal: config.optimizationGoal,
    targeting,
  };
  if (campaign.dailyBudgetCents) adsetBody.daily_budget = campaign.dailyBudgetCents;
  if (campaign.lifetimeBudgetCents) {
    adsetBody.lifetime_budget = campaign.lifetimeBudgetCents;
    adsetBody.end_time = (campaign.endTime ?? new Date(Date.now() + 7 * 86400_000)).toISOString();
  }
  if (campaign.startTime) adsetBody.start_time = campaign.startTime.toISOString();
  if (config.destinationType) adsetBody.destination_type = config.destinationType;
  if (config.needsPage) adsetBody.promoted_object = { page_id: account.fbPageId };

  const adset = await graphCall<{ id: string }>({
    host: "graph.facebook.com",
    method: "POST",
    path: `${adAccount}/adsets`,
    accessToken: access.accessToken,
    body: adsetBody,
  });

  // 3. Creative
  const creativeBody = await buildCreative(account, campaign);
  const creative = await graphCall<{ id: string }>({
    host: "graph.facebook.com",
    method: "POST",
    path: `${adAccount}/adcreatives`,
    accessToken: access.accessToken,
    body: creativeBody,
  });

  // 4. Ad (PAUSED)
  const ad = await graphCall<{ id: string }>({
    host: "graph.facebook.com",
    method: "POST",
    path: `${adAccount}/ads`,
    accessToken: access.accessToken,
    body: {
      name: `${campaign.name} — ad`,
      adset_id: adset.id,
      creative: { creative_id: creative.id },
      status: "PAUSED",
    },
  });

  log.info("campaign chain created in Meta (PAUSED)", {
    campaignId: campaign.id,
    metaCampaignId: camp.id,
  });

  return { metaCampaignId: camp.id, metaAdSetId: adset.id, metaCreativeId: creative.id, metaAdId: ad.id };
}

/**
 * The call_to_action block that renders the tappable button on the ad.
 *
 * Its `value` differs per objective — this is the piece that decides where the
 * button actually sends someone:
 *   OUTCOME_LEADS   → opens a Meta Instant Form   (needs metaFormId)
 *   OUTCOME_TRAFFIC → opens a URL                 (needs destinationUrl)
 *   OUTCOME_AWARENESS → opens a URL if one is set, otherwise no button
 *   OUTCOME_ENGAGEMENT → opens an Instagram Direct thread; routing comes from
 *                        the ad set's destination_type, so no value is sent
 *
 * Returns null when no button should be rendered.
 */
function buildCallToAction(campaign: Campaign): Record<string, unknown> | null {
  if (!campaign.ctaType) return null;

  switch (campaign.objective) {
    case "OUTCOME_LEADS":
      if (!campaign.metaFormId) {
        throw new AppError("VALIDATION", `The "${campaign.ctaType}" button needs an Instant Form`, {
          reason: "A Leads campaign sends people into a Meta lead form, so the form must exist first.",
          fix: "Attach an Instant Form to this campaign, or switch the objective to Traffic and give it a destination URL.",
        });
      }
      return { type: campaign.ctaType, value: { lead_gen_form_id: campaign.metaFormId } };

    case "OUTCOME_TRAFFIC":
      if (!campaign.destinationUrl) {
        throw new AppError("VALIDATION", `The "${campaign.ctaType}" button needs a destination URL`, {
          reason: "A Traffic campaign's button has to open a web page.",
          fix: "Set the destination URL — your hosted lead page works well here.",
        });
      }
      return { type: campaign.ctaType, value: { link: campaign.destinationUrl } };

    case "OUTCOME_ENGAGEMENT":
      // Destination is INSTAGRAM_DIRECT on the ad set; the button opens a DM.
      return { type: campaign.ctaType };

    case "OUTCOME_AWARENESS":
      return campaign.destinationUrl ? { type: campaign.ctaType, value: { link: campaign.destinationUrl } } : null;

    default:
      return null;
  }
}

async function buildCreative(account: InstagramAccount, campaign: Campaign): Promise<Record<string, unknown>> {
  // Boost an existing Instagram post/Reel — the verified pattern:
  // instagram_user_id + source_instagram_media_id (organic post is never modified;
  // Meta renders a copy of it as an ad, with the CTA button attached).
  if (campaign.contentId) {
    const content = await prisma.contentItem.findUnique({ where: { id: campaign.contentId } });
    if (!content) throw new AppError("NOT_FOUND", "Selected content no longer exists");
    const creative: Record<string, unknown> = {
      name: `${campaign.name} — creative`,
      instagram_user_id: account.igUserId,
      source_instagram_media_id: content.mediaId,
    };
    const cta = buildCallToAction(campaign);
    if (cta) creative.call_to_action = cta;
    return creative;
  }

  // Lead ads creative (Instant Form required)
  if (campaign.objective === "OUTCOME_LEADS") {
    const cta = buildCallToAction({ ...campaign, ctaType: campaign.ctaType ?? "SIGN_UP" });
    return {
      name: `${campaign.name} — creative`,
      object_story_spec: {
        page_id: account.fbPageId,
        link_data: {
          link: "https://fb.me/",
          message: (campaign.creativeSpec as { message?: string } | null)?.message ?? campaign.name,
          call_to_action: cta,
        },
      },
    };
  }

  // Link ad creative from spec
  const spec = (campaign.creativeSpec ?? {}) as { message?: string; imageUrl?: string };
  if (!campaign.destinationUrl) {
    throw new AppError("VALIDATION", "This campaign needs a destination URL or selected Instagram content");
  }
  const linkData: Record<string, unknown> = {
    link: campaign.destinationUrl,
    message: spec.message ?? campaign.name,
  };
  if (spec.imageUrl) linkData.picture = spec.imageUrl;
  const linkCta = buildCallToAction(campaign);
  if (linkCta) linkData.call_to_action = linkCta;
  return {
    name: `${campaign.name} — creative`,
    object_story_spec: { page_id: account.fbPageId, link_data: linkData },
  };
}

/** ACTIVATE = real money. Called only from the admin-confirmed publish route. */
export async function activateCampaignInMeta(account: InstagramAccount, campaign: Campaign): Promise<void> {
  assertAdsCapable(account);
  if (!campaign.metaCampaignId || !campaign.metaAdSetId || !campaign.metaAdId) {
    throw new AppError("VALIDATION", "Campaign has not been created in Meta yet");
  }
  const access = await resolveAdsAccess(account);
  for (const id of [campaign.metaCampaignId, campaign.metaAdSetId, campaign.metaAdId]) {
    await graphCall({
      host: "graph.facebook.com",
      method: "POST",
      path: id,
      accessToken: access.accessToken,
      body: { status: "ACTIVE" },
    });
  }
}

export async function pauseCampaignInMeta(account: InstagramAccount, campaign: Campaign): Promise<void> {
  assertAdsCapable(account);
  if (!campaign.metaCampaignId) return;
  const access = await resolveAdsAccess(account);
  await graphCall({
    host: "graph.facebook.com",
    method: "POST",
    path: campaign.metaCampaignId,
    accessToken: access.accessToken,
    body: { status: "PAUSED" },
  });
}

export interface CampaignLiveStatus {
  status: string | null;
  effectiveStatus: string | null;
  spend: string | null;
  impressions: string | null;
  clicks: string | null;
}

export async function fetchCampaignStatus(account: InstagramAccount, campaign: Campaign): Promise<CampaignLiveStatus> {
  assertAdsCapable(account);
  if (!campaign.metaCampaignId) {
    return { status: null, effectiveStatus: null, spend: null, impressions: null, clicks: null };
  }
  const access = await resolveAdsAccess(account);
  const info = await graphCall<{ status?: string; effective_status?: string }>({
    host: "graph.facebook.com",
    path: campaign.metaCampaignId,
    accessToken: access.accessToken,
    params: { fields: "status,effective_status" },
  });
  let spend: string | null = null;
  let impressions: string | null = null;
  let clicks: string | null = null;
  try {
    const insights = await graphCall<{ data: Array<{ spend?: string; impressions?: string; clicks?: string }> }>({
      host: "graph.facebook.com",
      path: `${campaign.metaCampaignId}/insights`,
      accessToken: access.accessToken,
      params: { fields: "spend,impressions,clicks" },
    });
    spend = insights.data?.[0]?.spend ?? null;
    impressions = insights.data?.[0]?.impressions ?? null;
    clicks = insights.data?.[0]?.clicks ?? null;
  } catch {
    // no delivery yet — fine
  }
  return {
    status: info.status ?? null,
    effectiveStatus: info.effective_status ?? null,
    spend,
    impressions,
    clicks,
  };
}

/** Create an Instant Form (lead ads). Requires pages_manage_ads + accepted lead-ads TOS. */
export async function createInstantForm(
  account: InstagramAccount,
  opts: { name: string; privacyPolicyUrl: string; questions: Array<{ type: string; label?: string }> },
): Promise<string> {
  assertAdsCapable(account);
  if (!account.fbPageId) throw metaUnsupported("Instant Forms", "No linked Facebook Page.");
  const page = await getPageToken(account);
  const res = await graphCall<{ id: string }>({
    host: "graph.facebook.com",
    method: "POST",
    path: `${account.fbPageId}/leadgen_forms`,
    accessToken: page,
    body: {
      name: opts.name,
      privacy_policy: { url: opts.privacyPolicyUrl },
      questions: opts.questions,
    },
  });
  return res.id;
}

/** Pull leads submitted to an Instant Form (needs leads_retrieval). */
export async function fetchFormLeads(account: InstagramAccount, formId: string) {
  const page = await getPageToken(account);
  return graphCall<{
    data: Array<{ id: string; created_time: string; field_data: Array<{ name: string; values: string[] }> }>;
  }>({
    host: "graph.facebook.com",
    path: `${formId}/leads`,
    accessToken: page,
    params: { fields: "id,created_time,field_data", limit: 50 },
  });
}

async function getPageToken(account: InstagramAccount): Promise<string> {
  const { getActiveToken } = await import("./tokens");
  const t = await getActiveToken(account.id, "page");
  if (!t) throw new AppError("META_TOKEN_EXPIRED", "Page token missing — reconnect the account");
  return t.token;
}

export async function listAdAccounts(account: InstagramAccount) {
  const access = await resolveAdsAccess(account);
  const res = await graphCall<{ data: Array<{ id: string; account_id: string; name: string; currency?: string }> }>({
    host: "graph.facebook.com",
    path: "me/adaccounts",
    accessToken: access.accessToken,
    params: { fields: "id,account_id,name,currency", limit: 25 },
  });
  return res.data ?? [];
}
