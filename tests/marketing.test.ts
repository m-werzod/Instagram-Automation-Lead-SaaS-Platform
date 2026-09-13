import { describe, expect, it } from "vitest";
import {
  buildCallToAction,
  buildTargeting,
  parseAdAccountBillingStatus,
  parseCampaignInsights,
  parseReachEstimate,
  resolveCtaAndUrl,
  statusFromMeta,
  targetingProblem,
} from "@/lib/meta/marketing";
import { campaignFieldsProblem, targetingSchema } from "@/lib/validation/campaign";

/**
 * Everything that decides what is sent to Meta — and how Meta's answers are
 * read back — is pure and pinned here. Audience numbers in particular come only
 * from reachestimate; when Meta has none, the platform says so.
 */

describe("buildTargeting", () => {
  it("sends countries, ages, genders, cities with radius and interests in Meta's shape", () => {
    const t = buildTargeting({
      countries: ["UZ", "KZ"],
      cities: [{ key: "2420605", name: "Tashkent", radius: 25, distanceUnit: "kilometer" }],
      ageMin: 21,
      ageMax: 40,
      genders: [2],
      interests: [{ id: "6003139266461", name: "Driving" }],
      instagramPositions: ["reels"],
    });
    expect(t).toEqual({
      geo_locations: { countries: ["UZ", "KZ"], cities: [{ key: "2420605", radius: 25, distance_unit: "kilometer" }] },
      publisher_platforms: ["instagram"],
      instagram_positions: ["reels"],
      targeting_automation: { advantage_audience: 0 },
      age_min: 21,
      age_max: 40,
      genders: [2],
      flexible_spec: [{ interests: [{ id: "6003139266461", name: "Driving" }] }],
    });
  });

  it("treats 'both genders' as no gender filter and clamps ages to 18–65", () => {
    const t = buildTargeting({ countries: ["UZ"], genders: [1, 2], ageMin: 13, ageMax: 99 });
    expect(t.genders).toBeUndefined();
    expect(t.age_min).toBe(18);
    expect(t.age_max).toBe(65);
    expect(t.instagram_positions).toEqual(["stream", "reels"]);
  });

  it("never invents a default country", () => {
    expect(buildTargeting(null).geo_locations).toEqual({});
    expect(targetingProblem(null)).toMatch(/country or city/);
    expect(targetingProblem({ countries: ["UZ"] })).toBeNull();
    expect(targetingProblem({ cities: [{ key: "1", radius: 5 }] })).toMatch(/radius/);
    expect(targetingProblem({ countries: ["UZ"], ageMin: 40, ageMax: 30 })).toMatch(/age/i);
  });
});

describe("parseReachEstimate", () => {
  it("reads Meta's bounds (object or array form)", () => {
    const a = parseReachEstimate({ data: { users_lower_bound: 120000, users_upper_bound: 141000, estimate_ready: true } });
    expect(a.available && a.usersLowerBound).toBe(120000);
    const b = parseReachEstimate({ data: [{ users_lower_bound: 5, users_upper_bound: 9 }] });
    expect(b.available && b.usersUpperBound).toBe(9);
  });
  it("reports unavailable for -1, not-ready or missing data instead of guessing", () => {
    expect(parseReachEstimate({ data: { users_lower_bound: -1, users_upper_bound: -1 } })).toEqual({
      available: false,
      reason: "Estimate unavailable until Meta processes this audience.",
    });
    expect(parseReachEstimate({ data: { users_lower_bound: 10, users_upper_bound: 20, estimate_ready: false } }).available).toBe(false);
    expect(parseReachEstimate({}).available).toBe(false);
  });
});

describe("parseCampaignInsights", () => {
  const row = {
    spend: "12.34",
    impressions: "5400",
    reach: "4100",
    clicks: "87",
    cpc: "0.14",
    ctr: "1.61",
    actions: [
      { action_type: "link_click", value: "80" },
      { action_type: "lead", value: "6" },
    ],
    date_start: "2026-09-01",
    date_stop: "2026-09-12",
  };
  it("picks the result action that matches the objective", () => {
    expect(parseCampaignInsights({ data: [row] }, "OUTCOME_LEADS", "USD")?.results).toBe(6);
    expect(parseCampaignInsights({ data: [row] }, "OUTCOME_TRAFFIC", "USD")?.results).toBe(80);
    expect(parseCampaignInsights({ data: [row] }, "OUTCOME_AWARENESS", "USD")?.results).toBe(4100);
    // objective whose action Meta did not report → 0, not null, not invented
    expect(parseCampaignInsights({ data: [row] }, "OUTCOME_ENGAGEMENT", "USD")?.results).toBe(0);
  });
  it("converts Meta's string numbers and keeps the currency", () => {
    const i = parseCampaignInsights({ data: [row] }, "OUTCOME_TRAFFIC", "UZS")!;
    expect(i.spend).toBeCloseTo(12.34);
    expect(i.impressions).toBe(5400);
    expect(i.cpc).toBeCloseTo(0.14);
    expect(i.currency).toBe("UZS");
    expect(i.dateStart).toBe("2026-09-01");
  });
  it("returns null when Meta has no rows yet", () => {
    expect(parseCampaignInsights({ data: [] }, "OUTCOME_TRAFFIC", "USD")).toBeNull();
  });
});

describe("statusFromMeta", () => {
  it("maps effective_status to the local lifecycle and ignores unknowns", () => {
    expect(statusFromMeta("ACTIVE")).toBe("ACTIVE");
    expect(statusFromMeta("CAMPAIGN_PAUSED")).toBe("PAUSED");
    expect(statusFromMeta("ARCHIVED")).toBe("ARCHIVED");
    expect(statusFromMeta("IN_PROCESS")).toBeNull();
    expect(statusFromMeta(null)).toBeNull();
  });
});

describe("buildCallToAction", () => {
  it("needs a form for Leads and a URL for Traffic", () => {
    expect(() => buildCallToAction({ ctaType: "SIGN_UP", objective: "OUTCOME_LEADS", metaFormId: null, destinationUrl: null })).toThrow(/Instant Form/);
    expect(buildCallToAction({ ctaType: "SIGN_UP", objective: "OUTCOME_LEADS", metaFormId: "f1", destinationUrl: null })).toEqual({
      type: "SIGN_UP",
      value: { lead_gen_form_id: "f1" },
    });
    expect(() => buildCallToAction({ ctaType: "LEARN_MORE", objective: "OUTCOME_TRAFFIC", metaFormId: null, destinationUrl: null })).toThrow(/destination URL/);
    expect(buildCallToAction({ ctaType: "MESSAGE_PAGE", objective: "OUTCOME_ENGAGEMENT", metaFormId: null, destinationUrl: null })).toEqual({ type: "MESSAGE_PAGE" });
    expect(buildCallToAction({ ctaType: null, objective: "OUTCOME_TRAFFIC", metaFormId: null, destinationUrl: "https://x" })).toBeNull();
  });
});

describe("campaign input validation", () => {
  it("accepts the wizard's targeting and upper-cases country codes", () => {
    const parsed = targetingSchema.parse({ countries: ["uz"], genders: [1], cities: [{ key: "1", radius: 20 }] });
    expect(parsed.countries).toEqual(["UZ"]);
  });
  it("rejects two budgets, no budget, lifetime without end, and reversed dates", () => {
    expect(campaignFieldsProblem({ dailyBudgetCents: 500, lifetimeBudgetCents: 5000 })).toMatch(/either/);
    expect(campaignFieldsProblem({})).toMatch(/budget is required/);
    expect(campaignFieldsProblem({ lifetimeBudgetCents: 5000 })).toMatch(/end date/);
    expect(campaignFieldsProblem({ dailyBudgetCents: 500, startTime: "2026-09-20T00:00:00Z", endTime: "2026-09-10T00:00:00Z" })).toMatch(/after/);
    expect(campaignFieldsProblem({ dailyBudgetCents: 500 })).toBeNull();
  });
});

describe("ad account billing status (Path 1 — Meta bills the ad account directly)", () => {
  it("is ready to spend only with a healthy status AND a funding source on file", () => {
    const ok = parseAdAccountBillingStatus("act_1", { account_status: 1, funding_source_details: { display_string: "Visa ****1234" } });
    expect(ok).toEqual({
      adAccountId: "act_1",
      statusCode: 1,
      statusLabel: "Active",
      readyToSpend: true,
      fundingSourceDisplay: "Visa ****1234",
      disableReason: null,
    });
  });
  it("is NOT ready when active but no funding source is on file yet", () => {
    const r = parseAdAccountBillingStatus("act_1", { account_status: 1 });
    expect(r.readyToSpend).toBe(false);
    expect(r.fundingSourceDisplay).toBeNull();
    expect(r.statusLabel).toBe("Active");
  });
  it("labels the documented Meta status codes and never fabricates readiness", () => {
    expect(parseAdAccountBillingStatus("a", { account_status: 3 }).statusLabel).toMatch(/Unsettled/);
    expect(parseAdAccountBillingStatus("a", { account_status: 9 }).statusLabel).toMatch(/grace period/);
    expect(parseAdAccountBillingStatus("a", { account_status: 2, funding_source_details: { display_string: "Visa" } }).readyToSpend).toBe(false);
  });
  it("falls back honestly when Meta returns an undocumented or missing status", () => {
    const unknownCode = parseAdAccountBillingStatus("a", { account_status: 555 });
    expect(unknownCode.statusLabel).toBe("Meta status 555");
    const missing = parseAdAccountBillingStatus("a", {});
    expect(missing.statusCode).toBeNull();
    expect(missing.statusLabel).toMatch(/did not report/);
    expect(missing.readyToSpend).toBe(false);
  });
  it("ignores a zero disable_reason (Meta's 'no reason' sentinel)", () => {
    expect(parseAdAccountBillingStatus("a", { account_status: 1, disable_reason: 0 }).disableReason).toBeNull();
    expect(parseAdAccountBillingStatus("a", { account_status: 2, disable_reason: 1 }).disableReason).toBe("1");
  });
});

/**
 * When a campaign is linked to a Lead Button (CtaConfig), its ctaType/destination
 * should win — but only for whichever half the CtaConfig actually specifies, so a
 * Lead Button with no ctaType of its own still falls back to the campaign's.
 */
describe("resolveCtaAndUrl", () => {
  const campaign = { ctaType: "SIGN_UP", destinationUrl: "https://campaign.example/own" };

  it("passes the campaign's own values through when nothing is linked", () => {
    expect(resolveCtaAndUrl(campaign, null)).toEqual({ ctaType: "SIGN_UP", destinationUrl: "https://campaign.example/own" });
  });

  it("a linked Lead Button with a hosted landing page wins over the campaign's own destination", () => {
    const linked = { ctaType: "LEARN_MORE", url: null, landingSlug: "abc123" };
    expect(resolveCtaAndUrl(campaign, linked)).toEqual({ ctaType: "LEARN_MORE", destinationUrl: "http://localhost:3000/f/abc123" });
  });

  it("a linked CtaConfig with only a plain url (not a hosted landing page) uses that url", () => {
    const linked = { ctaType: "LEARN_MORE", url: "https://example.com/promo", landingSlug: null };
    expect(resolveCtaAndUrl(campaign, linked)).toEqual({ ctaType: "LEARN_MORE", destinationUrl: "https://example.com/promo" });
  });

  it("falls back to the campaign's own ctaType/destination for whichever half the link doesn't specify", () => {
    expect(resolveCtaAndUrl(campaign, { ctaType: null, url: null, landingSlug: null })).toEqual(campaign);
  });
});
