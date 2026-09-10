import { prisma } from "@/lib/prisma";
import { createLogger, errorFields } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

const log = createLogger("audit");

/** Canonical audit actions (spec §29). String-typed in DB for forward compat. */
export const AuditActions = {
  LOGIN: "LOGIN",
  LOGIN_FAILED: "LOGIN_FAILED",
  LOGOUT: "LOGOUT",
  CREATED_ADMIN: "CREATED_ADMIN",
  UPDATED_ADMIN: "UPDATED_ADMIN",
  CONNECTED_INSTAGRAM: "CONNECTED_INSTAGRAM",
  RECONNECTED_INSTAGRAM: "RECONNECTED_INSTAGRAM",
  DISCONNECTED_INSTAGRAM: "DISCONNECTED_INSTAGRAM",
  SYNCED_CONTENT: "SYNCED_CONTENT",
  CREATED_AGENT: "CREATED_AGENT",
  UPDATED_AGENT: "UPDATED_AGENT",
  CHANGED_AGENT_PROMPT: "CHANGED_AGENT_PROMPT",
  DELETED_AGENT: "DELETED_AGENT",
  ENABLED_AUTOMATION: "ENABLED_AUTOMATION",
  DISABLED_AUTOMATION: "DISABLED_AUTOMATION",
  CREATED_AUTOMATION: "CREATED_AUTOMATION",
  UPDATED_AUTOMATION: "UPDATED_AUTOMATION",
  DELETED_AUTOMATION: "DELETED_AUTOMATION",
  CREATED_CAMPAIGN: "CREATED_CAMPAIGN",
  UPDATED_CAMPAIGN: "UPDATED_CAMPAIGN",
  CREATED_CAMPAIGN_IN_META: "CREATED_CAMPAIGN_IN_META",
  PUBLISHED_CAMPAIGN: "PUBLISHED_CAMPAIGN",
  PAUSED_CAMPAIGN: "PAUSED_CAMPAIGN",
  UPDATED_CTA: "UPDATED_CTA",
  CREATED_CTA: "CREATED_CTA",
  DELETED_CTA: "DELETED_CTA",
  CREATED_LEAD_FLOW: "CREATED_LEAD_FLOW",
  CHANGED_LEAD_FLOW: "CHANGED_LEAD_FLOW",
  DELETED_LEAD_FLOW: "DELETED_LEAD_FLOW",
  UPDATED_LEAD: "UPDATED_LEAD",
  CREATED_LEAD: "CREATED_LEAD",
  TOOK_OVER_CONVERSATION: "TOOK_OVER_CONVERSATION",
  RETURNED_CONVERSATION_TO_AI: "RETURNED_CONVERSATION_TO_AI",
  UPLOADED_KNOWLEDGE: "UPLOADED_KNOWLEDGE",
  DELETED_KNOWLEDGE: "DELETED_KNOWLEDGE",
  CHANGED_GLOBAL_SETTINGS: "CHANGED_GLOBAL_SETTINGS",
  MASTER_SWITCH_ON: "MASTER_SWITCH_ON",
  MASTER_SWITCH_OFF: "MASTER_SWITCH_OFF",
  SENT_TEST_EMAIL: "SENT_TEST_EMAIL",
  TESTED_CONNECTION: "TESTED_CONNECTION",
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];

export interface AuditEntry {
  adminId?: string | null;
  action: AuditAction | string;
  resourceType?: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  success?: boolean;
  error?: string;
}

/** Write an audit row. Never throws — auditing must not break the operation. */
export async function audit(entry: AuditEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        adminId: entry.adminId ?? null,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        before: entry.before === undefined ? undefined : (entry.before as Prisma.InputJsonValue),
        after: entry.after === undefined ? undefined : (entry.after as Prisma.InputJsonValue),
        ip: entry.ip ?? undefined,
        success: entry.success ?? true,
        error: entry.error,
      },
    });
  } catch (err) {
    log.error("failed to write audit log", { action: entry.action, ...errorFields(err) });
  }
}
