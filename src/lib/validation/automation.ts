import { z } from "zod";

/**
 * Automation rule input schemas shared by create and update routes — both
 * must validate `actions`/`conditions` identically, or an edit can silently
 * persist a shape `executeAction` (src/lib/automation/engine.ts) doesn't
 * recognise and it quietly no-ops at run time instead of being rejected here.
 */

/** null/omitted = no cooldown (fires every match). 60s–30d when set. */
export const cooldownSecSchema = z.number().int().min(60).max(2_592_000).nullable().optional();

export const conditionSchema = z.object({
  field: z.enum(["text", "source", "lead_status", "username"]),
  op: z.enum(["contains", "not_contains", "equals", "starts_with", "regex"]),
  value: z.string().min(1).max(300),
});

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("SEND_MESSAGE"), params: z.object({ text: z.string().min(1).max(900) }) }),
  z.object({ type: z.literal("SEND_PRIVATE_REPLY"), params: z.object({ text: z.string().min(1).max(900) }) }),
  z.object({ type: z.literal("REPLY_COMMENT"), params: z.object({ text: z.string().min(1).max(900) }) }),
  z.object({ type: z.literal("START_LEAD_FLOW"), params: z.object({ flowId: z.string().min(1) }) }),
  z.object({
    type: z.literal("SET_LEAD_STATUS"),
    params: z.object({ status: z.enum(["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"]) }),
  }),
  z.object({ type: z.literal("NOTIFY_ADMIN"), params: z.object({ text: z.string().min(1).max(2000) }) }),
  z.object({ type: z.literal("SET_AI"), params: z.object({ enabled: z.boolean() }) }),
  z.object({
    type: z.literal("SEND_COMMENT_RESOURCE"),
    params: z
      .object({
        mode: z.enum(["template", "ai"]),
        /** TEMPLATE: the literal message sent as-is. AI: the instruction given to the agent composing it. */
        text: z.string().min(1).max(900),
        resourceId: z.string().min(1).optional(),
        agentId: z.string().min(1).optional(),
      })
      .refine((p) => p.mode !== "ai" || Boolean(p.agentId), {
        message: "Pick which agent composes the reply for AI mode",
        path: ["agentId"],
      }),
  }),
]);
