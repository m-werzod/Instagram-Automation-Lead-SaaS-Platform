import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { runAutomations } from "@/lib/automation/engine";

/** Human takeover: AI stops responding in this conversation immediately. */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;
  const existing = await prisma.conversation.findUnique({ where: { id } });
  if (!existing) throw notFound("Conversation");

  const conversation = await prisma.conversation.update({
    where: { id },
    data: { aiEnabled: false, status: "HUMAN", takenOverByAdminId: auth.admin.id },
  });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.TOOK_OVER_CONVERSATION,
    resourceType: "conversation",
    resourceId: id,
    ip: clientIp(req),
  });
  await runAutomations("CONVERSATION_HANDOFF", {
    accountId: conversation.accountId,
    conversationId: conversation.id,
    igsid: conversation.igsid,
  });
  return ok({ conversation });
});
