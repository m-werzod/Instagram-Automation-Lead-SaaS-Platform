import { prisma } from "@/lib/prisma";
import { route, ok, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { notFound } from "@/lib/errors";
import { isWithinMessagingWindow } from "@/lib/meta/messaging";

/** Newest slice of the thread returned to the inbox. */
const MESSAGE_LIMIT = 200;

export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const conversation = await prisma.conversation.findUnique({
    where: { id },
    include: {
      account: { select: { id: true, username: true, isDemo: true } },
      agent: { select: { id: true, name: true, enabled: true } },
      // Newest-first so a long thread keeps its LATEST messages (the ones an
      // admin is answering); the one extra row is how "is there anything older"
      // is answered without a second count query.
      messages: { orderBy: { createdAt: "desc" }, take: MESSAGE_LIMIT + 1 },
      flowSessions: {
        orderBy: { startedAt: "desc" },
        take: 3,
        include: { flow: { select: { name: true } } },
      },
    },
  });
  if (!conversation) throw notFound("Conversation");
  await assertAccountAccess(auth, conversation.accountId);

  const lead = conversation.leadId
    ? await prisma.lead.findUnique({
        where: { id: conversation.leadId },
        select: { id: true, name: true, phone: true, email: true, status: true },
      })
    : null;

  const olderOmitted = conversation.messages.length > MESSAGE_LIMIT;
  const messages = conversation.messages.slice(0, MESSAGE_LIMIT).reverse(); // oldest → newest for display

  return ok({
    conversation: { ...conversation, messages },
    lead,
    messagingWindowOpen: isWithinMessagingWindow(conversation.lastUserMessageAt),
    messagePage: { limit: MESSAGE_LIMIT, returned: messages.length, olderOmitted },
  });
});
