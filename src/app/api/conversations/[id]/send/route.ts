import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, type RouteCtx } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { notFound } from "@/lib/errors";
import { sendInstagramText } from "@/lib/meta/messaging";

const sendSchema = z.object({
  text: z.string().min(1).max(950),
  /** Human-agent tag: only for manual admin sends within 7 days, needs Meta approval of the permission. */
  humanAgentTag: z.boolean().default(false),
});

/** Manual admin send. Takes the conversation over implicitly (AI paused). */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;
  const body = await parseBody(req, sendSchema);

  const conversation = await prisma.conversation.findUnique({ where: { id }, include: { account: true } });
  if (!conversation) throw notFound("Conversation");

  const sent = await sendInstagramText(conversation.account, conversation.igsid, body.text, {
    lastUserMessageAt: conversation.lastUserMessageAt,
    humanAgentTag: body.humanAgentTag,
  });

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
      data: { lastMessageAt: new Date(), lastMessagePreview: body.text.slice(0, 140) },
    }),
  ]);
  return ok({ message });
});
