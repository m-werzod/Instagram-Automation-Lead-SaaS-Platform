import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { sendInstagramText } from "@/lib/meta/messaging";
import { runAutomations } from "@/lib/automation/engine";
import { touchLead } from "@/lib/leads";

const sendSchema = z.object({
  text: z.string().min(1).max(950),
  /** Human-agent tag: only for manual admin sends within 7 days, needs Meta approval of the permission. */
  humanAgentTag: z.boolean().default(false),
});

/** Manual admin send. Takes the conversation over implicitly (AI paused). */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, sendSchema);

  const conversation = await prisma.conversation.findUnique({ where: { id }, include: { account: true } });
  if (!conversation) throw notFound("Conversation");
  await assertAccountAccess(auth, conversation.accountId);

  const sent = await sendInstagramText(conversation.account, conversation.igsid, body.text, {
    lastUserMessageAt: conversation.lastUserMessageAt,
    humanAgentTag: body.humanAgentTag,
  });

  // The takeover this endpoint claims has to be REAL: a human is answering
  // now, so the AI must stop replying in this conversation — the same state the
  // explicit takeover endpoint writes, applied once, on the transition only.
  const takingOver = conversation.aiEnabled || conversation.status !== "HUMAN";
  const takeover = takingOver
    ? { aiEnabled: false, status: "HUMAN" as const, takenOverByAdminId: auth.admin.id }
    : {};

  const [message] = await prisma.$transaction([
    prisma.message.create({
      data: {
        conversationId: id,
        mid: sent.messageId,
        direction: "OUT",
        sender: "ADMIN",
        text: body.text,
        sentByAdminId: auth.admin.id,
      },
    }),
    prisma.conversation.update({
      where: { id },
      data: { lastMessageAt: new Date(), lastMessagePreview: body.text.slice(0, 140), ...takeover },
    }),
  ]);
  if (conversation.leadId) await touchLead(conversation.leadId);

  if (takingOver) {
    await audit({
      adminId: auth.admin.id,
      action: AuditActions.TOOK_OVER_CONVERSATION,
      resourceType: "conversation",
      resourceId: id,
      after: { via: "manual_send" },
      ip: clientIp(req),
    });
    await runAutomations("CONVERSATION_HANDOFF", {
      accountId: conversation.accountId,
      conversationId: id,
      igsid: conversation.igsid,
    });
  }
  return ok({ message, aiPaused: takingOver });
});
