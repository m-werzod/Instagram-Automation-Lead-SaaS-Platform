import { prisma } from "@/lib/prisma";
import { route, ok, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { notFound } from "@/lib/errors";
import { isWithinMessagingWindow } from "@/lib/meta/messaging";

export const GET = route(async (_req, ctx: RouteCtx) => {
  await requireAdmin();
  const id = await pathParam(ctx, "id");
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      account: { select: { id: true, username: true, isDemo: true } },
      agent: { select: { id: true, name: true, enabled: true } },
      messages: { orderBy: { createdAt: "asc" }, take: 200 },
      flowSessions: {
        orderBy: { startedAt: "desc" },
        take: 3,
        include: { flow: { select: { name: true } } },
      },
    },
  });
  if (!conversation) throw notFound("Conversation");

  const lead = conversation.leadId
    ? await prisma.lead.findUnique({
        where: { id: conversation.leadId },
        select: { id: true, name: true, phone: true, email: true, status: true },
      })
    : null;

  return ok({
    conversation,
    lead,
    messagingWindowOpen: isWithinMessagingWindow(conversation.lastUserMessageAt),
  });
});
