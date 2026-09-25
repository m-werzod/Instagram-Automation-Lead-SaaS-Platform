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

// ---------- answer patterns (admin-supplied regex) ----------

/**
 * A question's validationRegex is written by an admin but executed against
 * untrusted input on the PUBLIC landing page, and JavaScript cannot abort a
 * RegExp once it starts backtracking. The defence is therefore entirely
 * up-front: refuse catastrophic patterns at save time, anchor what we do store,
 * and never feed a pattern more than a bounded amount of text.
 */
export const MAX_VALIDATION_REGEX_LENGTH = 200;
export const MAX_VALIDATED_ANSWER_LENGTH = 512;
const MAX_REPETITION_COUNT = 1000;
/**
 * A chain of open-ended repeats over overlapping characters costs O(nᵏ) even
 * with no group in sight: `[a-z]+[a-z]+[a-z]+[a-z]+@` needs ~30 s on a
 * 512-character answer, while three of them need ~0.2 s. Three is therefore the
 * budget, and MAX_VALIDATED_ANSWER_LENGTH is what keeps that bound true.
 */
const MAX_OPEN_ENDED_REPEATS = 3;
/**
 * Ways a *bounded* ambiguous group can carve up one string. `(\d{1,3}\.){3}`
 * is 3³ = 27 and harmless; `(a{1,100}){1,100}` is astronomical.
 */
const MAX_GROUP_COMBINATIONS = 1_000_000;

interface Quantifier {
  /** characters consumed by the quantifier itself */
  length: number;
  /** `*`, `+`, `{n,}` — the multiplier that turns ambiguity into exponential work */
  unbounded: boolean;
  /** largest written repetition count, for the size cap */
  count: number;
  /** smallest repetition count */
  min: number;
  /** largest repetition count (Infinity when unbounded) */
  max: number;
  /** `min !== max` — the quantifier can match the same text at several lengths */
  variable: boolean;
}

function quantifier(length: number, min: number, max: number): Quantifier {
  return {
    length,
    unbounded: max === Infinity,
    count: Number.isFinite(max) ? max : min,
    min,
    max,
    variable: max > min,
  };
}

function readQuantifier(source: string, i: number): Quantifier | null {
  const ch = source[i];
  const lazy = (at: number) => (source[at] === "?" ? 1 : 0);
  if (ch === "*") return quantifier(1 + lazy(i + 1), 0, Infinity);
  if (ch === "+") return quantifier(1 + lazy(i + 1), 1, Infinity);
  if (ch === "?") return quantifier(1 + lazy(i + 1), 0, 1);
  if (ch === "{") {
    const m = /^\{(\d+)(,(\d+)?)?\}/.exec(source.slice(i));
    if (!m) return null; // a literal "{" — JS allows it outside a quantifier
    const min = Number(m[1]);
    const openEnded = m[2] !== undefined && m[3] === undefined;
    const max = openEnded ? Infinity : m[3] !== undefined ? Number(m[3]) : min;
    return quantifier(m[0].length + lazy(i + m[0].length), min, max);
  }
  return null;
}

/** A repeat wide enough to drive polynomial cost: open-ended, or a span of 2+. */
function isOpenEnded(q: Quantifier): boolean {
  return q.unbounded || q.max - q.min >= 2;
}

interface Frame {
  /** the body can match the same text in more than one way (it repeats or alternates) */
  ambiguous: boolean;
  /** the body's own length is open-ended, so repeating it scales with the answer */
  openEnded: boolean;
  /** how many distinct ways a bounded body can split one string (approximate, multiplicative) */
  combinations: number;
}

function newFrame(): Frame {
  return { ambiguous: false, openEnded: false, combinations: 1 };
}

/**
 * Catastrophic backtracking needs two ingredients: a body that can match the
 * same text in several ways (it repeats or alternates), and a way to repeat
 * that body. Reject those shapes rather than trying to time the match — JS
 * cannot abort a RegExp once it starts.
 *
 * Three shapes are refused:
 *  1. an ambiguous group under an unbounded quantifier — `(a+)+`, `(a|a)*`;
 *  2. an ambiguous group under a *counted* quantifier that can still repeat —
 *     `(?:[a-z]+){1,5}` is the same bomb written with a number, and a bounded
 *     body is refused too once its split count explodes (`(a{1,100}){1,100}`);
 *  3. more than MAX_OPEN_ENDED_REPEATS open-ended repeats anywhere in the
 *     pattern, which is polynomial blow-up needing no group at all.
 */
function catastrophicRisk(source: string): string | null {
  const AMBIGUOUS_REPEAT = "repeats a group that already repeats — it can hang the page on a long answer";
  const frames: Frame[] = [newFrame()];
  let openEndedRepeats = 0;
  let inClass = false;

  const countRepeat = (q: Quantifier) => {
    if (isOpenEnded(q)) openEndedRepeats++;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      continue;
    }
    if (ch === "(") {
      frames.push(newFrame());
      const prefix = /^\?(:|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/.exec(source.slice(i + 1));
      if (prefix) i += prefix[0].length;
      continue;
    }
    if (ch === ")") {
      if (frames.length === 1) return "has unbalanced brackets";
      const group = frames.pop()!;
      const parent = frames[frames.length - 1]!;
      const q = readQuantifier(source, i + 1);
      if (q) {
        if (q.count > MAX_REPETITION_COUNT) return `repeats something more than ${MAX_REPETITION_COUNT} times`;
        if (group.ambiguous && q.max > 1) {
          // An open-ended body repeated at all is the classic bomb; a bounded
          // body is judged by how many splits it can offer.
          if (q.unbounded || group.openEnded) return AMBIGUOUS_REPEAT;
          if (Math.pow(group.combinations, q.max) > MAX_GROUP_COMBINATIONS) return AMBIGUOUS_REPEAT;
        }
        countRepeat(q);
        i += q.length;
        parent.ambiguous = parent.ambiguous || q.variable || group.ambiguous;
        parent.openEnded = parent.openEnded || q.unbounded || group.openEnded;
        parent.combinations *= Number.isFinite(q.max) ? Math.pow(group.combinations, q.max) : group.combinations;
        continue;
      }
      parent.ambiguous = parent.ambiguous || group.ambiguous;
      parent.openEnded = parent.openEnded || group.openEnded;
      parent.combinations *= group.combinations;
      continue;
    }
    if (ch === "|") {
      frames[frames.length - 1]!.ambiguous = true;
      continue;
    }
    const q = readQuantifier(source, i);
    if (q) {
      if (q.count > MAX_REPETITION_COUNT) return `repeats something more than ${MAX_REPETITION_COUNT} times`;
      countRepeat(q);
      const frame = frames[frames.length - 1]!;
      if (q.variable) {
        frame.ambiguous = true;
        frame.openEnded = frame.openEnded || q.unbounded;
        if (Number.isFinite(q.max)) frame.combinations *= q.max - q.min + 1;
      }
      i += q.length - 1;
      continue;
    }
  }
  if (frames.length !== 1) return "has unbalanced brackets";
  if (openEndedRepeats > MAX_OPEN_ENDED_REPEATS) {
    return `stacks more than ${MAX_OPEN_ENDED_REPEATS} open-ended repeats — a long answer would take too long to check`;
  }
  return null;
}

/** null = safe to store. Otherwise a predicate completing "Answer pattern …". */
export function validationRegexIssue(source: string): string | null {
  const pattern = source.trim();
  if (!pattern) return null;
  if (pattern.length > MAX_VALIDATION_REGEX_LENGTH) return `is longer than ${MAX_VALIDATION_REGEX_LENGTH} characters`;
  try {
    new RegExp(pattern);
  } catch {
    return "is not a valid regular expression";
  }
  return catastrophicRisk(pattern);
}

/**
 * Anchored: a pattern describes the WHOLE answer, so "ABC-1" written as
 * `[A-Z]{3}-\d+` can no longer be satisfied by burying it in junk.
 */
export function compileAnswerPattern(source: string): RegExp | null {
  const pattern = source.trim();
  if (!pattern || validationRegexIssue(pattern)) return null;
  try {
    return new RegExp(`^(?:${pattern})$`);
  } catch {
    return null;
  }
}

/** null = unusable pattern; callers accept the answer rather than block a customer on an admin's typo. */
export function testAnswerPattern(source: string, input: string): boolean | null {
  const re = compileAnswerPattern(source);
  if (!re) return null;
  if (input.length > MAX_VALIDATED_ANSWER_LENGTH) return false;
  return re.test(input);
}

/** questionSchema + the regex screen, for every route that stores questions. */
export const safeQuestionSchema = questionSchema.superRefine((q, ctx) => {
  if (!q.validationRegex) return;
  const issue = validationRegexIssue(q.validationRegex);
  if (issue) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["validationRegex"], message: `Answer pattern ${issue}` });
  }
});

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
  questions: z.array(safeQuestionSchema).min(1).max(25),
});

export type LeadButtonSaveInput = z.infer<typeof leadButtonSaveSchema>;
