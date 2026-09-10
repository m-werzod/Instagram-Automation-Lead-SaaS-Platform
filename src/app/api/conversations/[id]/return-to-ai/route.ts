import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";

/** Return the conversation to the AI agent. */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const existing = await prisma.conversation.findUnique({ where: { id } });
  if (!existing) throw notFound("Conversation");

  const conversation = await prisma.conversation.update({
    where: { id },
    data: { aiEnabled: true, status: "OPEN", takenOverByAdminId: null },
  });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.RETURNED_CONVERSATION_TO_AI,
    resourceType: "conversation",
    resourceId: id,
    ip: clientIp(req),
  });
  return ok({ conversation });
});
