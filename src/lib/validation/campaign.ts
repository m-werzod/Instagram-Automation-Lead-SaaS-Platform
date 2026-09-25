import { z } from "zod";

/**
 * Campaign input schemas shared by create and update routes. Mirrors what
 * Meta actually accepts (docs/META_API.md §8): ISO country codes, city keys
 * from the targeting search, 18–65 ages, 1/2 genders, interest ids.
 */

export const citySchema = z.object({
  key: z.string().min(1).max(40),
  name: z.string().max(120).optional(),
  radius: z.number().int().min(10).max(80).optional(),
  distanceUnit: z.enum(["kilometer", "mile"]).optional(),
});

export const interestSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().max(120).optional(),
});

/** Meta's radius window, stated per unit (50 mi = 80.45 km, so these differ). */
export function cityRadiusBounds(distanceUnit?: "kilometer" | "mile"): { min: number; max: number; unit: string } {
  return distanceUnit === "mile" ? { min: 10, max: 50, unit: "miles" } : { min: 17, max: 80, unit: "km" };
}

/**
 * Cross-field rules live here as well as in marketing.ts's targetingProblem, so
 * an impossible audience is refused when the campaign is SAVED rather than at
 * "Create in Meta" — which happens only after the platform fee has been paid.
 * (The location requirement deliberately stays out: a half-filled draft is
 * legitimate, and createCampaignInMeta still refuses one with no location.)
 */
export const targetingSchema = z
  .object({
    countries: z.array(z.string().length(2).toUpperCase()).max(25).optional(),
    cities: z.array(citySchema).max(25).optional(),
    ageMin: z.number().int().min(18).max(65).optional(),
    ageMax: z.number().int().min(18).max(65).optional(),
    genders: z.array(z.number().int().min(1).max(2)).max(2).optional(),
    interests: z.array(interestSchema).max(25).optional(),
    instagramPositions: z.array(z.enum(["stream", "story", "explore", "reels"])).optional(),
  })
  .superRefine((t, ctx) => {
    if (t.ageMin !== undefined && t.ageMax !== undefined && t.ageMin > t.ageMax) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["ageMax"], message: "Minimum age is above maximum age" });
    }
    (t.cities ?? []).forEach((c, i) => {
      if (c.radius === undefined) return;
      const { min, max, unit } = cityRadiusBounds(c.distanceUnit);
      if (c.radius < min || c.radius > max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cities", i, "radius"],
          message: `City radius must be ${min}–${max} ${unit} (Meta allows 17–80 km / 10–50 miles)`,
        });
      }
    });
  });

export type TargetingInput = z.infer<typeof targetingSchema>;

export const objectiveSchema = z.enum(["OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_AWARENESS"]);

export const creativeSpecSchema = z
  .object({ message: z.string().max(2000).optional(), imageUrl: z.string().url().optional() })
  .nullable()
  .optional();

export const campaignFieldsSchema = z.object({
  name: z.string().min(1).max(150),
  objective: objectiveSchema,
  dailyBudgetCents: z.number().int().min(100).max(100_000_000).nullable().optional(),
  lifetimeBudgetCents: z.number().int().min(100).max(1_000_000_000).nullable().optional(),
  currency: z.string().length(3).default("USD"),
  startTime: z.string().datetime().nullable().optional(),
  endTime: z.string().datetime().nullable().optional(),
  targeting: targetingSchema.nullable().optional(),
  ctaType: z.string().max(40).nullable().optional(),
  destinationType: z.enum(["WEBSITE", "INSTAGRAM_DIRECT", "LEAD_FORM"]).nullable().optional(),
  destinationUrl: z.string().url().nullable().optional(),
  leadFlowId: z.string().nullable().optional(),
  contentId: z.string().nullable().optional(),
  /** Which Lead Button (CtaConfig) this ad uses, if any — see marketing.ts's resolveCtaAndUrl. */
  ctaConfigId: z.string().nullable().optional(),
  metaFormId: z.string().max(40).nullable().optional(),
  creativeSpec: creativeSpecSchema,
});

/** Draft-level sanity: one budget kind, dates in order, lifetime needs an end. */
export function campaignFieldsProblem(b: {
  dailyBudgetCents?: number | null;
  lifetimeBudgetCents?: number | null;
  startTime?: string | null;
  endTime?: string | null;
}): string | null {
  if (b.dailyBudgetCents && b.lifetimeBudgetCents) return "Choose either a daily or a lifetime budget, not both";
  if (!b.dailyBudgetCents && !b.lifetimeBudgetCents) return "A budget is required";
  if (b.lifetimeBudgetCents && !b.endTime) return "A lifetime budget needs an end date";
  if (b.startTime && b.endTime && new Date(b.endTime).getTime() <= new Date(b.startTime).getTime()) return "End date must be after the start date";
  return null;
}
