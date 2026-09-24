import { prisma } from "@/lib/prisma";

/**
 * Cross-cutting Lead helpers used by the webhook pipeline, the agent tools and
 * the CRM API — kept in one place so "what counts as an interaction" has a
 * single definition.
 */

/** Bump lastInteractionAt. Never throws — this is bookkeeping, not the main path. */
export async function touchLead(leadId: string | null | undefined): Promise<void> {
  if (!leadId) return;
  await prisma.lead.update({ where: { id: leadId }, data: { lastInteractionAt: new Date() } }).catch(() => undefined);
}

/** Same, but resolved from a conversation id (the common case: a message arrived). */
export async function touchLeadByConversation(conversationId: string): Promise<void> {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { leadId: true } });
  if (conversation?.leadId) await touchLead(conversation.leadId);
}

export type QualificationLevel = "LOW" | "MEDIUM" | "HIGH";

export interface AiQualification {
  score: QualificationLevel;
  summary: string;
  qualifiedAt: string;
  agentId: string;
}

export function isQualificationLevel(v: unknown): v is QualificationLevel {
  return v === "LOW" || v === "MEDIUM" || v === "HIGH";
}

// ---------- CRM board: paging ----------

/** The kanban loads a whole account at once, so the page stays large; it is the cap that matters. */
export const DEFAULT_LEADS_PAGE_SIZE = 500;
export const MAX_LEADS_PAGE_SIZE = 500;

export function parseLeadPage(limit: string | null, offset: string | null): { limit: number; offset: number } {
  const wantedLimit = Number.parseInt(limit ?? "", 10);
  const wantedOffset = Number.parseInt(offset ?? "", 10);
  return {
    limit: Number.isFinite(wantedLimit) ? Math.min(Math.max(wantedLimit, 1), MAX_LEADS_PAGE_SIZE) : DEFAULT_LEADS_PAGE_SIZE,
    offset: Number.isFinite(wantedOffset) && wantedOffset > 0 ? wantedOffset : 0,
  };
}

// ---------- CRM fields staff edit by hand ----------

export const MAX_LEAD_TAGS = 20;
export const MAX_LEAD_TAG_LENGTH = 40;
/** Lead.valueCents is a Postgres INTEGER — a larger amount cannot be stored at all. */
export const MAX_LEAD_VALUE_CENTS = 2_147_483_647;

/** Trim, drop blanks, de-duplicate case-insensitively (first spelling wins), cap the list. */
export function normalizeLeadTags(tags: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, " ").slice(0, MAX_LEAD_TAG_LENGTH);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
    if (normalized.length === MAX_LEAD_TAGS) break;
  }
  return normalized;
}

export interface LeadCrmFields {
  tags: string[];
  followUpAt: Date | null;
  valueCents: number | null;
  valueCurrency: string | null;
  outcomeReason: string | null;
}

export type LeadCrmPatch = Partial<LeadCrmFields>;

export interface LeadCrmChange {
  type: "TAGS_CHANGED" | "FOLLOW_UP_CHANGED" | "VALUE_CHANGED" | "OUTCOME_CHANGED";
  data: Record<string, unknown>;
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

function sameMoment(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}

/**
 * Apply a CRM patch to the stored values, enforcing the rules the database
 * cannot state for itself: money needs a currency to mean anything, an outcome
 * reason only describes a lead that was actually won or lost, and an amount has
 * to fit the column it is written to.
 */
export function applyLeadCrmPatch(
  current: LeadCrmFields,
  patch: LeadCrmPatch,
  resultingStatus: string,
): { ok: true; fields: LeadCrmFields } | { ok: false; error: string } {
  const fields: LeadCrmFields = {
    tags: patch.tags !== undefined ? normalizeLeadTags(patch.tags) : current.tags,
    followUpAt: patch.followUpAt !== undefined ? patch.followUpAt : current.followUpAt,
    valueCents: patch.valueCents !== undefined ? patch.valueCents : current.valueCents,
    valueCurrency: patch.valueCurrency !== undefined ? patch.valueCurrency : current.valueCurrency,
    outcomeReason: patch.outcomeReason !== undefined ? patch.outcomeReason : current.outcomeReason,
  };

  // Both rules judge what this edit submits, never what is already stored: a
  // lead whose stored values break a rule would otherwise refuse every later
  // edit — dragging a won lead back to In progress is a status-only PATCH, and
  // it must not fail over the reason recorded when it was won.
  const touchesValue = patch.valueCents !== undefined || patch.valueCurrency !== undefined;
  if (fields.valueCents === null) fields.valueCurrency = null;
  else if (touchesValue && !fields.valueCurrency) return { ok: false, error: "Choose a currency for the deal value" };

  // Postgres rejects an over-sized INTEGER with a 500 the admin cannot act on.
  if (fields.valueCents !== null && fields.valueCents > MAX_LEAD_VALUE_CENTS) {
    return {
      ok: false,
      error: `Deal value is too large — the maximum is ${(MAX_LEAD_VALUE_CENTS / 100).toFixed(2)} in the chosen currency`,
    };
  }

  if (patch.outcomeReason && resultingStatus !== "WON" && resultingStatus !== "LOST") {
    return { ok: false, error: "An outcome reason only applies to a lead marked Won or Lost" };
  }

  return { ok: true, fields };
}

/** The columns to write and the LeadEvents to record for a CRM edit — only what really moved. */
export function leadCrmChanges(before: LeadCrmFields, after: LeadCrmFields): { data: LeadCrmPatch; events: LeadCrmChange[] } {
  const data: LeadCrmPatch = {};
  const events: LeadCrmChange[] = [];

  if (!sameTags(before.tags, after.tags)) {
    data.tags = after.tags;
    const lower = (list: string[]) => new Set(list.map((t) => t.toLowerCase()));
    const had = lower(before.tags);
    const has = lower(after.tags);
    events.push({
      type: "TAGS_CHANGED",
      data: {
        added: after.tags.filter((t) => !had.has(t.toLowerCase())),
        removed: before.tags.filter((t) => !has.has(t.toLowerCase())),
      },
    });
  }

  if (!sameMoment(before.followUpAt, after.followUpAt)) {
    data.followUpAt = after.followUpAt;
    events.push({
      type: "FOLLOW_UP_CHANGED",
      data: { from: before.followUpAt?.toISOString() ?? null, to: after.followUpAt?.toISOString() ?? null },
    });
  }

  if (before.valueCents !== after.valueCents || before.valueCurrency !== after.valueCurrency) {
    data.valueCents = after.valueCents;
    data.valueCurrency = after.valueCurrency;
    events.push({
      type: "VALUE_CHANGED",
      data: {
        from: before.valueCents === null ? null : { cents: before.valueCents, currency: before.valueCurrency },
        to: after.valueCents === null ? null : { cents: after.valueCents, currency: after.valueCurrency },
      },
    });
  }

  if (before.outcomeReason !== after.outcomeReason) {
    data.outcomeReason = after.outcomeReason;
    events.push({ type: "OUTCOME_CHANGED", data: { from: before.outcomeReason, to: after.outcomeReason } });
  }

  return { data, events };
}
