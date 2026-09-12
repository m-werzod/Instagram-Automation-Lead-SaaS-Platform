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
