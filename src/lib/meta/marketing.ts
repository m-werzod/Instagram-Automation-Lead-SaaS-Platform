import type { Campaign, CtaConfig, InstagramAccount } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError, metaUnsupported } from "@/lib/errors";
import { createLogger, errorFields } from "@/lib/logger";
import { coreEnv } from "@/lib/env";
import { cityRadiusBounds } from "@/lib/validation/campaign";
import { graphCall, MetaApiError } from "./client";
import { resolveAdsAccess } from "./tokens";
import { Prisma } from "@prisma/client";

const log = createLogger("meta.marketing");

/**
 * Marketing API integration (docs/META_API.md §8).
 * HARD SAFETY RULES:
 *  - everything is created with status=PAUSED,
 *  - activation (real spend) only via activateCampaignInMeta(), which the API
 *    layer gates behind explicit admin confirmation + audit (spec §16),
 *  - audience numbers come ONLY from Meta's reachestimate; nothing is invented.
 * Only vetted, verified CTA types and objectives are exposed.
 */

export const SUPPORTED_OBJECTIVES = [
  { value: "OUTCOME_TRAFFIC", label: "Traffic (website clicks)" },
  { value: "OUTCOME_ENGAGEMENT", label: "Engagement (incl. Instagram Direct)" },
  { value: "OUTCOME_LEADS", label: "Leads (Instant Forms)" },
  { value: "OUTCOME_AWARENESS", label: "Awareness (reach)" },
] as const;

export type Objective = (typeof SUPPORTED_OBJECTIVES)[number]["value"];

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
  /** which `actions` entry counts as a result in insights */
  resultAction: string | null;
}

export const OBJECTIVE_CONFIG: Record<Objective, ObjectiveConfig> = {
  OUTCOME_TRAFFIC: { optimizationGoal: "LINK_CLICKS", billingEvent: "IMPRESSIONS", needsPage: false, resultAction: "link_click" },
  OUTCOME_ENGAGEMENT: {
    optimizationGoal: "CONVERSATIONS",
    billingEvent: "IMPRESSIONS",
    destinationType: "INSTAGRAM_DIRECT",
    needsPage: true,
    resultAction: "onsite_conversion.messaging_conversation_started_7d",
  },
  OUTCOME_LEADS: {
    optimizationGoal: "LEAD_GENERATION",
    billingEvent: "IMPRESSIONS",
    destinationType: "ON_AD",
    needsPage: true,
    resultAction: "lead",
  },
  OUTCOME_AWARENESS: { optimizationGoal: "REACH", billingEvent: "IMPRESSIONS", needsPage: true, resultAction: null },
};

// ---- targeting ----

export interface CampaignCity {
  key: string;
  name?: string;
  radius?: number;
  distanceUnit?: "kilometer" | "mile";
}

export interface CampaignInterest {
  id: string;
  name?: string;
}

export interface CampaignTargeting {
  countries?: string[];
  cities?: CampaignCity[];
  ageMin?: number;
  ageMax?: number;
  genders?: number[]; // 1 = men, 2 = women (Meta convention); empty = all
  interests?: CampaignInterest[];
  instagramPositions?: string[];
}

/** Meta needs at least one location; everything else is optional. */
export function targetingProblem(t: CampaignTargeting | null | undefined): string | null {
  if (!t?.countries?.length && !t?.cities?.length) return "Choose at least one country or city";
  if (t.ageMin !== undefined && t.ageMax !== undefined && t.ageMin > t.ageMax) return "Minimum age is above maximum age";
  for (const c of t.cities ?? []) {
    if (c.radius !== undefined) {
      // Meta's limits are stated per unit — 10–50 miles OR 17–80 km — and those
      // are not the same window (50 mi = 80.45 km). The radius is sent to Meta
      // in the unit it was given, so the bound has to be checked in that unit:
      // converting first rejected both of Meta's own documented mile bounds.
      // Shared with the input schema so the two layers cannot drift apart.
      const { min, max, unit } = cityRadiusBounds(c.distanceUnit);
      if (c.radius < min || c.radius > max) return `City radius must be ${min}–${max} ${unit} (Meta allows 17–80 km / 10–50 miles)`;
    }
  }
  return null;
}

/** The exact `targeting` object sent to Meta (unit-tested). */
export function buildTargeting(t: CampaignTargeting | null): Record<string, unknown> {
  const geo: Record<string, unknown> = {};
  if (t?.countries?.length) geo.countries = t.countries;
  if (t?.cities?.length) {
    geo.cities = t.cities.map((c) => ({
      key: c.key,
      ...(c.radius ? { radius: c.radius, distance_unit: c.distanceUnit ?? "kilometer" } : {}),
    }));
  }
  const targeting: Record<string, unknown> = {
    geo_locations: geo,
    publisher_platforms: ["instagram"],
    instagram_positions: t?.instagramPositions?.length ? t.instagramPositions : ["stream", "reels"],
    // explicit choice, not Meta's default expansion — predictable targeting
    targeting_automation: { advantage_audience: 0 },
  };
  if (t?.ageMin) targeting.age_min = Math.max(18, t.ageMin);
  if (t?.ageMax) targeting.age_max = Math.min(65, t.ageMax);
  if (t?.genders?.length && t.genders.length < 2) targeting.genders = t.genders;
  if (t?.interests?.length) {
    targeting.flexible_spec = [{ interests: t.interests.map((i) => ({ id: i.id, ...(i.name ? { name: i.name } : {}) })) }];
  }
  return targeting;
}

/**
 * Advertising readiness is decided by the ad account link, not by how Instagram
 * was connected — an Instagram Login account gains campaigns as soon as the
 * admin completes the separate Facebook (ads) authorization.
 */
export function assertAdsCapable(account: InstagramAccount): void {
  if (!account.adAccountId) {
    throw metaUnsupported(
      "Campaigns",
      "No Meta ad account is linked to this Instagram account yet.",
      "Open the Instagram page and use 'Connect Facebook (for ads)'. It adds advertising without affecting your Instagram messaging connection.",
    );
  }
}

// ---- reach estimate (the ONLY source of audience numbers) ----

export type ReachEstimate =
  | { available: true; usersLowerBound: number; usersUpperBound: number; fetchedAt: string }
  | { available: false; reason: string };

/**
 * Read one of Meta's bounds, or null when Meta did not actually give a number.
 * Bare Number() is too generous to ask with: Number(null), Number(""),
 * Number(" ") and Number([]) are all 0, and Number(true) is 1. A zero reach
 * estimate is a real answer this product renders as such, so coercing "Meta
 * said nothing" into it invents an audience size and shows it as fact — the
 * same failure mode as rendering the -1 sentinel. (parseCampaignInsights' own
 * `opt()` draws this line for the metrics; this is the same rule for bounds.)
 */
function reachBound(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function parseReachEstimate(json: Record<string, unknown>): ReachEstimate {
  const node = (Array.isArray(json.data) ? json.data[0] : json.data) as Record<string, unknown> | undefined;
  const lower = node ? reachBound(node.users_lower_bound) : null;
  const upper = node ? reachBound(node.users_upper_bound) : null;
  // lower/upper < 0 is Meta's -1 "cannot tell you" sentinel.
  if (!node || node.estimate_ready === false || lower === null || upper === null || lower < 0 || upper < 0) {
    return { available: false, reason: "Estimate unavailable until Meta processes this audience." };
  }
  return { available: true, usersLowerBound: lower, usersUpperBound: upper, fetchedAt: new Date().toISOString() };
}

export async function fetchReachEstimate(account: InstagramAccount, targeting: CampaignTargeting): Promise<ReachEstimate> {
  if (!account.adAccountId) {
    return { available: false, reason: "Connect Facebook (ads) to get Meta's audience estimate for this targeting." };
  }
  const problem = targetingProblem(targeting);
  if (problem) return { available: false, reason: problem };
  const access = await resolveAdsAccess(account);
  try {
    const json = await graphCall<Record<string, unknown>>({
      host: "graph.facebook.com",
      path: `${account.adAccountId}/reachestimate`,
      accessToken: access.accessToken,
      params: { targeting_spec: buildTargeting(targeting) },
    });
    return parseReachEstimate(json);
  } catch (err) {
    log.warn("reachestimate failed", { accountId: account.id, ...errorFields(err) });
    const reason = err instanceof MetaApiError ? `${err.message}${err.reason ? ` — ${err.reason}` : ""}` : "Meta did not return an estimate.";
    return { available: false, reason };
  }
}

// ---- targeting search (interests, cities) ----

export interface InterestSuggestion {
  id: string;
  name: string;
  path: string[];
  audienceLower: number | null;
  audienceUpper: number | null;
}

export async function searchInterests(account: InstagramAccount, q: string): Promise<InterestSuggestion[]> {
  const access = await resolveAdsAccess(account);
  const json = await graphCall<{ data?: Array<Record<string, unknown>> }>({
    host: "graph.facebook.com",
    path: "search",
    accessToken: access.accessToken,
    params: { type: "adinterest", q, limit: 15 },
  });
  return (json.data ?? []).map((r) => ({
    id: String(r.id),
    name: String(r.name ?? ""),
    path: Array.isArray(r.path) ? (r.path as string[]) : [],
    audienceLower: typeof r.audience_size_lower_bound === "number" ? r.audience_size_lower_bound : null,
    audienceUpper: typeof r.audience_size_upper_bound === "number" ? r.audience_size_upper_bound : null,
  }));
}

export interface CitySuggestion {
  key: string;
  name: string;
  region: string | null;
  countryCode: string;
  countryName: string | null;
}

export async function searchCities(account: InstagramAccount, q: string, countryCode?: string): Promise<CitySuggestion[]> {
  const access = await resolveAdsAccess(account);
  const json = await graphCall<{ data?: Array<Record<string, unknown>> }>({
    host: "graph.facebook.com",
    path: "search",
    accessToken: access.accessToken,
    params: {
      type: "adgeolocation",
      location_types: ["city"],
      q,
      limit: 15,
      ...(countryCode ? { country_code: countryCode } : {}),
    },
  });
  return (json.data ?? []).map((r) => ({
    key: String(r.key),
    name: String(r.name ?? ""),
    region: typeof r.region === "string" ? r.region : null,
    countryCode: String(r.country_code ?? ""),
    countryName: typeof r.country_name === "string" ? r.country_name : null,
  }));
}

// ---- create / lifecycle ----

export interface MetaCampaignIds {
  metaCampaignId: string;
  metaAdSetId: string;
  metaCreativeId: string;
  metaAdId: string;
}

export type CampaignChainStep = "campaign" | "adset" | "creative" | "ad" | "done";

/**
 * Which step of the Meta chain still has to be created — the FIRST missing id
 * wins. Pure so the resume rule is pinned by a test: every object Meta returned
 * before a failure is a real row in Ads Manager, and a retry that started from
 * scratch would leave it there forever with nothing referencing it.
 */
export function nextCreationStep(campaign: Pick<Campaign, "metaCampaignId" | "metaAdSetId" | "metaCreativeId" | "metaAdId">): CampaignChainStep {
  if (!campaign.metaCampaignId) return "campaign";
  if (!campaign.metaAdSetId) return "adset";
  if (!campaign.metaCreativeId) return "creative";
  if (!campaign.metaAdId) return "ad";
  return "done";
}

/**
 * Create the full campaign→adset→creative→ad chain in Meta, ALL PAUSED.
 * Local Campaign row must already exist (status DRAFT/READY).
 *
 * Each id is written to that row the moment Meta returns it, and a call that
 * finds ids already there resumes from the first missing step. Meta has no
 * transaction across these four calls, so this is the only way a retry after a
 * mid-chain failure stops stacking up orphaned campaigns and ad sets.
 */
export async function createCampaignInMeta(account: InstagramAccount, campaign: Campaign): Promise<MetaCampaignIds> {
  assertAdsCapable(account);
  const access = await resolveAdsAccess(account);
  const adAccount = account.adAccountId!; // "act_..."
  const config = OBJECTIVE_CONFIG[campaign.objective as Objective];
  if (!config) {
    throw new AppError("VALIDATION", `Objective ${campaign.objective} is not supported`, {
      fix: `Use one of: ${SUPPORTED_OBJECTIVES.map((o) => o.value).join(", ")}`,
    });
  }
  if (config.needsPage && !account.fbPageId) {
    throw metaUnsupported("This campaign objective", "It requires a linked Facebook Page.", "Reconnect via Facebook Login.");
  }
  // Anything that is not a boost of an existing Instagram post is published as
  // an object_story_spec, which Meta requires a page_id on. Checked HERE, before
  // the first Graph call, because failing at the creative step would leave a real
  // campaign and ad set behind in Ads Manager with nothing pointing at them.
  if (!campaign.contentId && !account.fbPageId) {
    throw metaUnsupported(
      "This campaign",
      "Its ad creative is published by a Facebook Page, and no Page is linked to this Instagram account.",
      "Connect Facebook (for ads) including a Page, or pick an existing Instagram post to boost instead.",
    );
  }
  if (!campaign.dailyBudgetCents && !campaign.lifetimeBudgetCents) {
    throw new AppError("VALIDATION", "Campaign needs a daily or lifetime budget");
  }
  const targeting = campaign.targeting as CampaignTargeting | null;
  const problem = targetingProblem(targeting);
  if (problem) throw new AppError("VALIDATION", problem);
  if (campaign.lifetimeBudgetCents && !campaign.endTime) {
    throw new AppError("VALIDATION", "A lifetime budget needs an end date");
  }

  const resumedFrom = nextCreationStep(campaign);
  if (resumedFrom !== "campaign") log.info("resuming Meta campaign chain", { campaignId: campaign.id, from: resumedFrom });
  const remember = (data: Prisma.CampaignUpdateInput) => prisma.campaign.update({ where: { id: campaign.id }, data });

  // 1. Campaign (PAUSED)
  let metaCampaignId = campaign.metaCampaignId;
  if (!metaCampaignId) {
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
    metaCampaignId = camp.id;
    await remember({ metaCampaignId });
  }

  // 2. Ad set (PAUSED)
  let metaAdSetId = campaign.metaAdSetId;
  if (!metaAdSetId) {
    const adsetBody: Record<string, unknown> = {
      name: `${campaign.name} — ad set`,
      campaign_id: metaCampaignId,
      status: "PAUSED",
      billing_event: config.billingEvent,
      optimization_goal: config.optimizationGoal,
      targeting: buildTargeting(targeting),
    };
    if (campaign.dailyBudgetCents) adsetBody.daily_budget = campaign.dailyBudgetCents;
    if (campaign.lifetimeBudgetCents) {
      adsetBody.lifetime_budget = campaign.lifetimeBudgetCents;
      adsetBody.end_time = campaign.endTime!.toISOString();
    } else if (campaign.endTime) {
      adsetBody.end_time = campaign.endTime.toISOString();
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
    metaAdSetId = adset.id;
    await remember({ metaAdSetId });
  }

  // 3. Creative
  let metaCreativeId = campaign.metaCreativeId;
  if (!metaCreativeId) {
    const creativeBody = await buildCreative(account, campaign);
    const creative = await graphCall<{ id: string }>({
      host: "graph.facebook.com",
      method: "POST",
      path: `${adAccount}/adcreatives`,
      accessToken: access.accessToken,
      body: creativeBody,
    });
    metaCreativeId = creative.id;
    await remember({ metaCreativeId });
  }

  // 4. Ad (PAUSED)
  let metaAdId = campaign.metaAdId;
  if (!metaAdId) {
    const ad = await graphCall<{ id: string }>({
      host: "graph.facebook.com",
      method: "POST",
      path: `${adAccount}/ads`,
      accessToken: access.accessToken,
      body: {
        name: `${campaign.name} — ad`,
        adset_id: metaAdSetId,
        creative: { creative_id: metaCreativeId },
        status: "PAUSED",
      },
    });
    metaAdId = ad.id;
    await remember({ metaAdId });
  }

  log.info("campaign chain created in Meta (PAUSED)", {
    campaignId: campaign.id,
    metaCampaignId,
    resumedFrom,
  });

  return { metaCampaignId, metaAdSetId, metaCreativeId, metaAdId };
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
export function buildCallToAction(campaign: Pick<Campaign, "ctaType" | "objective" | "metaFormId" | "destinationUrl">): Record<string, unknown> | null {
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

/** `/f/{slug}` — kept local rather than imported from src/app/api/lead-button/route.ts's
 *  identical landingUrlFor, since lib/ code importing from app/api/ would invert this
 *  codebase's dependency direction. Small intentional duplication. */
function ctaConfigDestinationUrl(cta: Pick<CtaConfig, "url" | "landingSlug">): string | null {
  return cta.landingSlug ? `${coreEnv().APP_URL}/f/${cta.landingSlug}` : cta.url;
}

/**
 * Pure (unit-tested): when a campaign is linked to a Lead Button (CtaConfig),
 * its ctaType/destination win over the campaign's own plain columns — with
 * the campaign's own values as the fallback for whichever half the CtaConfig
 * doesn't specify. `linkedCta` is null for a campaign with no Lead Button.
 */
export function resolveCtaAndUrl(
  campaign: Pick<Campaign, "ctaType" | "destinationUrl">,
  linkedCta: Pick<CtaConfig, "ctaType" | "url" | "landingSlug"> | null,
): { ctaType: string | null; destinationUrl: string | null } {
  if (!linkedCta) return { ctaType: campaign.ctaType, destinationUrl: campaign.destinationUrl };
  return {
    ctaType: linkedCta.ctaType ?? campaign.ctaType,
    destinationUrl: ctaConfigDestinationUrl(linkedCta) ?? campaign.destinationUrl,
  };
}

async function buildCreative(account: InstagramAccount, campaign: Campaign): Promise<Record<string, unknown>> {
  // A linked Lead Button's CTA/destination win, resolved once here — read live
  // at creation time only (Meta ad creatives are immutable afterward, so
  // there is never a later "sync" moment to re-derive this into).
  if (campaign.ctaConfigId) {
    const linkedCta = await prisma.ctaConfig.findUnique({
      where: { id: campaign.ctaConfigId },
      select: { ctaType: true, url: true, landingSlug: true },
    });
    campaign = { ...campaign, ...resolveCtaAndUrl(campaign, linkedCta) };
  }

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

/** ACTIVATE = real money. Called only from the admin-confirmed publish route (also used to RESUME a paused campaign). */
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

/** STOP = archive in Meta. Delivery ends for good; history and spend stay readable in Ads Manager. */
export async function stopCampaignInMeta(account: InstagramAccount, campaign: Campaign): Promise<void> {
  assertAdsCapable(account);
  if (!campaign.metaCampaignId) return;
  const access = await resolveAdsAccess(account);
  await graphCall({
    host: "graph.facebook.com",
    method: "POST",
    path: campaign.metaCampaignId,
    accessToken: access.accessToken,
    body: { status: "ARCHIVED" },
  });
}

/**
 * Why this campaign cannot be paused, or null when it can. Pausing acts on
 * something that is live in Meta; a local draft has nothing to pause, and
 * marking it PAUSED anyway strands it — the create-in-Meta route only accepts
 * DRAFT/READY/ERROR, and editing is only allowed in those states too, so the
 * campaign could then neither be built nor changed.
 */
export function campaignPauseProblem(status: Campaign["status"]): string | null {
  switch (status) {
    case "ACTIVE":
    case "PAUSED":
    case "CREATED":
      return null;
    case "DRAFT":
    case "READY":
      return "This campaign has not been created in Meta yet — there is nothing running to pause.";
    case "ERROR":
      return "This campaign never made it into Meta — there is nothing running to pause.";
    case "ARCHIVED":
      return "This campaign is archived — it is already stopped for good.";
  }
}

/**
 * Why this campaign cannot be archived locally, or null when it can. Archiving
 * only hides it HERE; Meta keeps delivering, and keeps spending the ad account's
 * money, until Meta itself is told to stop. `live` is Meta's own answer, or null
 * when there is nothing in Meta to ask about (a local draft, a demo account).
 */
export function campaignArchiveProblem(localStatus: Campaign["status"], live: CampaignLiveStatus | null): string | null {
  // A reply carrying neither field is not an answer: reading it as "not running"
  // would hide a campaign nobody confirmed had stopped, so fall back to what is
  // known locally exactly as if Meta had not been asked.
  const verdict = live && (live.effectiveStatus || live.status) ? live : null;
  const stillRunning = verdict ? verdict.effectiveStatus === "ACTIVE" || verdict.status === "ACTIVE" : localStatus === "ACTIVE";
  if (!stillRunning) return null;
  return "This campaign is still ACTIVE in Meta — archiving it here would only hide it while Meta keeps delivering and charging the ad account. Stop it (or pause it) first, then archive.";
}

/**
 * Which object of the Meta chain owns each editable field. Meta copies these
 * values when the object is created and never re-reads the local row.
 */
const FIELD_OWNER: Record<string, "campaign" | "adset" | "creative"> = {
  objective: "campaign",
  dailyBudgetCents: "adset",
  lifetimeBudgetCents: "adset",
  startTime: "adset",
  endTime: "adset",
  targeting: "adset",
  contentId: "creative",
  creativeSpec: "creative",
  ctaType: "creative",
  ctaConfigId: "creative",
  destinationType: "creative",
  destinationUrl: "creative",
  metaFormId: "creative",
};

const OWNER_WORDS: Record<"campaign" | "adset" | "creative", { object: string; fields: string }> = {
  campaign: { object: "campaign", fields: "objective" },
  adset: { object: "ad set", fields: "budget, schedule and targeting" },
  creative: { object: "ad creative", fields: "creative, destination and button" },
};

/**
 * Why these changed fields can no longer be saved, or null. A chain that failed
 * halfway leaves real objects in Meta and the retry RESUMES from the first
 * missing one (see nextCreationStep), so a field an existing object already
 * owns would never reach Meta — saving it would show a budget here that Meta is
 * not spending.
 */
export function campaignEditProblem(
  campaign: Pick<Campaign, "metaCampaignId" | "metaAdSetId" | "metaCreativeId">,
  changedFields: string[],
): string | null {
  const created = { campaign: campaign.metaCampaignId, adset: campaign.metaAdSetId, creative: campaign.metaCreativeId };
  const owners = [...new Set(changedFields.map((f) => FIELD_OWNER[f]).filter((o) => o && created[o]))] as Array<"campaign" | "adset" | "creative">;
  if (owners.length === 0) return null;
  const objects = owners.map((o) => OWNER_WORDS[o].object).join(" and ");
  const fields = owners.map((o) => OWNER_WORDS[o].fields).join(", ");
  return `This campaign's ${objects} already ${owners.length > 1 ? "exist" : "exists"} in Meta, and Meta keeps the ${fields} it was created with — so that can no longer be changed here. Use "Create in Meta" to finish this campaign, change it in Meta Ads Manager, or stop it and build a new one.`;
}

// ---- status + insights (real numbers from Meta) ----

export interface CampaignLiveStatus {
  status: string | null;
  effectiveStatus: string | null;
}

export async function fetchCampaignStatus(account: InstagramAccount, campaign: Campaign): Promise<CampaignLiveStatus> {
  assertAdsCapable(account);
  if (!campaign.metaCampaignId) return { status: null, effectiveStatus: null };
  const access = await resolveAdsAccess(account);
  const info = await graphCall<{ status?: string; effective_status?: string }>({
    host: "graph.facebook.com",
    path: campaign.metaCampaignId,
    accessToken: access.accessToken,
    params: { fields: "status,effective_status" },
  });
  return { status: info.status ?? null, effectiveStatus: info.effective_status ?? null };
}

// ---- ad review (Meta's verdict, never guessed here) ----

export interface CampaignReviewIssue {
  level: string | null;
  code: number | null;
  summary: string | null;
  message: string | null;
}

export interface CampaignReview {
  /** Meta's own effective_status for the AD: PENDING_REVIEW | DISAPPROVED | WITH_ISSUES | ACTIVE | … */
  status: string | null;
  issues: CampaignReviewIssue[] | null;
}

/**
 * Meta reviews the AD, not the campaign, so the verdict is read from the ad's
 * effective_status plus whatever issues_info it carries. Nothing is derived
 * locally: an ad Meta has said nothing about stays null rather than being
 * called "approved".
 */
export function parseAdReview(json: Record<string, unknown>): CampaignReview {
  const status = typeof json.effective_status === "string" && json.effective_status ? json.effective_status : null;
  const rows = (Array.isArray(json.issues_info) ? json.issues_info : []) as Array<Record<string, unknown>>;
  const issues = rows.map((r) => ({
    level: typeof r.level === "string" ? r.level : null,
    code: Number.isFinite(Number(r.error_code)) ? Number(r.error_code) : null,
    summary: typeof r.error_summary === "string" ? r.error_summary : null,
    message: typeof r.error_message === "string" ? r.error_message : null,
  }));
  return { status, issues: issues.length > 0 ? issues : null };
}

/** Null when there is no ad in Meta yet — there is then no review to report. */
export async function fetchAdReview(account: InstagramAccount, campaign: Campaign): Promise<CampaignReview | null> {
  assertAdsCapable(account);
  if (!campaign.metaAdId) return null;
  const access = await resolveAdsAccess(account);
  const json = await graphCall<Record<string, unknown>>({
    host: "graph.facebook.com",
    path: campaign.metaAdId,
    accessToken: access.accessToken,
    params: { fields: "effective_status,issues_info" },
  });
  return parseAdReview(json);
}

export interface CampaignInsights {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  results: number | null;
  resultAction: string | null;
  cpc: number | null;
  ctr: number | null;
  currency: string;
  dateStart: string | null;
  dateStop: string | null;
  fetchedAt: string;
}

/** Reads Meta's insights row; results = the action matching the objective (null when Meta reports none). */
export function parseCampaignInsights(json: Record<string, unknown>, objective: string, currency: string): CampaignInsights | null {
  const row = (Array.isArray(json.data) ? json.data[0] : undefined) as Record<string, unknown> | undefined;
  if (!row) return null;
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const opt = (v: unknown): number | null => (v === undefined || v === null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  const config = OBJECTIVE_CONFIG[objective as Objective];
  const actions = (Array.isArray(row.actions) ? row.actions : []) as Array<{ action_type?: string; value?: string | number }>;
  let results: number | null = null;
  if (config?.resultAction) {
    const hit = actions.find((a) => a.action_type === config.resultAction);
    results = hit ? num(hit.value) : 0;
  } else if (objective === "OUTCOME_AWARENESS") {
    results = num(row.reach);
  }
  return {
    spend: num(row.spend),
    impressions: num(row.impressions),
    reach: num(row.reach),
    clicks: num(row.clicks),
    results,
    resultAction: config?.resultAction ?? (objective === "OUTCOME_AWARENESS" ? "reach" : null),
    cpc: opt(row.cpc),
    ctr: opt(row.ctr),
    currency,
    dateStart: typeof row.date_start === "string" ? row.date_start : null,
    dateStop: typeof row.date_stop === "string" ? row.date_stop : null,
    fetchedAt: new Date().toISOString(),
  };
}

export async function fetchCampaignInsights(account: InstagramAccount, campaign: Campaign): Promise<CampaignInsights | null> {
  assertAdsCapable(account);
  if (!campaign.metaCampaignId) return null;
  const access = await resolveAdsAccess(account);
  const json = await graphCall<Record<string, unknown>>({
    host: "graph.facebook.com",
    path: `${campaign.metaCampaignId}/insights`,
    accessToken: access.accessToken,
    params: { fields: "spend,impressions,reach,clicks,cpc,ctr,actions", date_preset: "maximum" },
  });
  return parseCampaignInsights(json, campaign.objective, campaign.currency);
}

/** Local status implied by Meta's effective_status; null = leave as is. */
export function statusFromMeta(effectiveStatus: string | null): Campaign["status"] | null {
  switch (effectiveStatus) {
    case "ACTIVE":
      return "ACTIVE";
    case "PAUSED":
    case "CAMPAIGN_PAUSED":
    case "ADSET_PAUSED":
      return "PAUSED";
    case "ARCHIVED":
    case "DELETED":
      return "ARCHIVED";
    default:
      return null;
  }
}

/** Pull status + spend/results + Meta's ad review verdict, and store the snapshot on the campaign. */
export async function syncCampaignFromMeta(
  account: InstagramAccount,
  campaign: Campaign,
): Promise<{ status: CampaignLiveStatus; insights: CampaignInsights | null; review: CampaignReview | null }> {
  const status = await fetchCampaignStatus(account, campaign);
  let insights: CampaignInsights | null = null;
  try {
    insights = await fetchCampaignInsights(account, campaign);
  } catch (err) {
    log.warn("insights unavailable", { campaignId: campaign.id, ...errorFields(err) });
  }
  // A review Meta would not talk about is left exactly as it was — the stored
  // verdict is only ever Meta's own words, never a local guess or a stale one
  // overwritten with "unknown".
  let review: CampaignReview | null = null;
  try {
    review = await fetchAdReview(account, campaign);
  } catch (err) {
    log.warn("ad review unavailable", { campaignId: campaign.id, ...errorFields(err) });
  }
  const implied = statusFromMeta(status.effectiveStatus);
  // Only reconcile states Meta can change on its own (a schedule ending, an
  // admin acting in Ads Manager) — never resurrect something archived locally.
  const nextStatus =
    implied && campaign.status !== "ARCHIVED" && campaign.status !== "DRAFT" && campaign.status !== "READY" && campaign.status !== "ERROR"
      ? implied
      : undefined;
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: {
      ...(insights ? { insightsSnapshot: insights as unknown as Prisma.InputJsonValue } : {}),
      insightsSyncedAt: new Date(),
      ...(review
        ? {
            reviewStatus: review.status,
            reviewIssues: (review.issues as unknown as Prisma.InputJsonValue) ?? Prisma.DbNull,
            reviewSyncedAt: new Date(),
          }
        : {}),
      ...(nextStatus ? { status: nextStatus } : {}),
      ...(nextStatus === "ARCHIVED" && !campaign.stoppedAt ? { stoppedAt: new Date() } : {}),
    },
  });
  return { status, insights, review };
}

/** Meta-rendered preview of the created ad (HTML iframe) — the real thing, available once the creative exists. */
export async function fetchAdPreview(account: InstagramAccount, campaign: Campaign, format = "INSTAGRAM_STANDARD"): Promise<string | null> {
  assertAdsCapable(account);
  if (!campaign.metaCreativeId) return null;
  const access = await resolveAdsAccess(account);
  const json = await graphCall<{ data?: Array<{ body?: string }> }>({
    host: "graph.facebook.com",
    path: `${campaign.metaCreativeId}/previews`,
    accessToken: access.accessToken,
    params: { ad_format: format },
  });
  return json.data?.[0]?.body ?? null;
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

// ---- ad-account billing status ("pay Meta directly", kept entirely on Meta's own rails) ----

/**
 * Meta's own account_status enum (Marketing API `AdAccount.account_status`,
 * verified 2026-09-13). 201/202 are query FILTER values only — Meta never
 * returns them on a real account, so they are deliberately not mapped here.
 */
export const AD_ACCOUNT_STATUS_LABELS: Record<number, string> = {
  1: "Active",
  2: "Disabled",
  3: "Unsettled — a bill is unpaid",
  7: "Pending risk review",
  8: "Pending settlement",
  9: "In grace period — payment is overdue",
  100: "Pending closure",
  101: "Closed",
};

export interface AdAccountBillingStatus {
  adAccountId: string;
  /** Meta's raw account_status code; null when Meta returned nothing usable. */
  statusCode: number | null;
  statusLabel: string;
  /** true only when Meta confirms both a healthy status AND a funding source on file. */
  readyToSpend: boolean;
  /** Display string for the card/method on file (e.g. "Visa ****1234"), when Meta returns one. */
  fundingSourceDisplay: string | null;
  disableReason: string | null;
}

/** Reads Meta's own words on whether this ad account is a real place to spend money — never guessed locally. */
export function parseAdAccountBillingStatus(adAccountId: string, json: Record<string, unknown>): AdAccountBillingStatus {
  const rawStatus = json.account_status;
  const statusCode = typeof rawStatus === "number" ? rawStatus : Number.isFinite(Number(rawStatus)) ? Number(rawStatus) : null;
  const funding = json.funding_source_details as { display_string?: string } | undefined;
  const fundingSourceDisplay = typeof funding?.display_string === "string" && funding.display_string.trim() ? funding.display_string.trim() : null;
  const disableReasonCode = json.disable_reason;
  return {
    adAccountId,
    statusCode,
    statusLabel: statusCode !== null ? (AD_ACCOUNT_STATUS_LABELS[statusCode] ?? `Meta status ${statusCode}`) : "Unknown — Meta did not report a status",
    readyToSpend: statusCode === 1 && fundingSourceDisplay !== null,
    fundingSourceDisplay,
    disableReason: disableReasonCode !== undefined && disableReasonCode !== null && disableReasonCode !== 0 ? String(disableReasonCode) : null,
  };
}

/**
 * The ONLY payment-method check this platform performs for Meta ad spend: a
 * read of the ad account's own status. Never a card entry, never a charge —
 * Meta requires that to happen on Meta's own hosted billing page, verified at
 * https://www.facebook.com/business/help/132073386867900. If Meta returns
 * nothing usable (older API tiers sometimes omit funding_source_details),
 * this reports "unknown" rather than asserting a false positive or negative.
 */
export async function fetchAdAccountBillingStatus(account: InstagramAccount): Promise<AdAccountBillingStatus | null> {
  if (!account.adAccountId) return null;
  const access = await resolveAdsAccess(account);
  try {
    const json = await graphCall<Record<string, unknown>>({
      host: "graph.facebook.com",
      path: account.adAccountId,
      accessToken: access.accessToken,
      params: { fields: "account_status,disable_reason,funding_source_details" },
    });
    return parseAdAccountBillingStatus(account.adAccountId, json);
  } catch (err) {
    log.warn("ad account billing status unavailable", { accountId: account.id, ...errorFields(err) });
    return null;
  }
}

/** Meta's own billing page. There is no query parameter Meta guarantees will preselect one ad account across every Business Manager version, so the UI shows the account name/id next to this link instead of pretending one exists. */
export const META_BILLING_HUB_URL = "https://business.facebook.com/billing_hub/payment_settings";
