import { z } from "zod";
import { questionSchema } from "./leadflow";

/**
 * Lead Button — the platform's core object. One per Instagram account.
 *
 * Honest surface mapping (docs/META_API.md):
 *  - The styled button below is rendered on surfaces WE own: the hosted
 *    landing page /f/{slug} and the builder preview.
 *  - Instagram's own native CTA button (paid ads) is rendered by Instagram
 *    with a fixed look — only its text (ctaType enum) is configurable.
 *  - Organic Reels cannot carry a real button; the honest paths are the
 *    landing link and DM keyword flows. The UI says so explicitly.
 */

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Expected a #RRGGBB colour");

export const buttonSpecSchema = z.object({
  /** Text on the button itself, e.g. "Ro‘yxatdan o‘tish". */
  label: z.string().min(1).max(30),
  /** Optional supporting line shown next to the button. */
  helper: z.string().max(90).default(""),
  bg: hexColor,
  fg: hexColor,
  /** null = no border (filled look) */
  border: hexColor.nullable().default(null),
  shape: z.enum(["pill", "rounded", "square"]).default("rounded"),
  size: z.enum(["sm", "md", "lg"]).default("md"),
  style: z.enum(["filled", "outline"]).default("filled"),
  /** Where the start button sits on the landing intro screen. */
  position: z.enum(["bottom", "center"]).default("bottom"),
});

export type ButtonSpec = z.infer<typeof buttonSpecSchema>;

export const DEFAULT_BUTTON_SPEC: ButtonSpec = {
  label: "Ro‘yxatdan o‘tish",
  helper: "",
  bg: "#4f46e5",
  fg: "#ffffff",
  border: null,
  shape: "rounded",
  size: "md",
  style: "filled",
  position: "bottom",
};

/** Parse a stored buttonSpec JSON defensively (old rows may hold null/garbage). */
export function parseButtonSpec(value: unknown): ButtonSpec {
  const res = buttonSpecSchema.safeParse(value);
  return res.success ? res.data : DEFAULT_BUTTON_SPEC;
}

/** Full Lead Button save payload — upserted atomically in /api/lead-button. */
export const leadButtonSaveSchema = z.object({
  accountId: z.string().min(1),
  enabled: z.boolean(),
  /** Headline the customer sees (also the flow name). */
  headline: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  completionMessage: z.string().max(900).nullable().optional(),
  buttonSpec: buttonSpecSchema,
  /** null = the whole account (all Reels); otherwise one ContentItem id. */
  contentId: z.string().nullable(),
  /** Preferred native ad CTA (SIGN_UP, LEARN_MORE, …) — used when promoting. */
  ctaType: z.string().max(40).nullable(),
  /** DM/comment keywords that start the question flow inside Instagram. */
  triggerKeywords: z.array(z.string().min(1).max(60)).max(20),
  /** Ordered questions (order = array order). */
  questions: z.array(questionSchema).min(1).max(25),
});

export type LeadButtonSaveInput = z.infer<typeof leadButtonSaveSchema>;
