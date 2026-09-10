import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { AppError, notFound } from "@/lib/errors";
import { enqueue } from "@/lib/queue";
import { sha256Hex } from "@/lib/crypto";

/**
 * DEV-ONLY webhook simulator (spec §43 dev-mode): feeds a synthetic inbound
 * DM through the exact same pipeline as a real Meta webhook (persist →
 * dedupe → queue → worker). Enabled only when ENABLE_DEV_SIMULATOR=true and
 * NODE_ENV !== production. Real signatures are not required because this
 * never bypasses admin auth.
 */

const schema = z.object({
  accountId: z.string().min(1),
  igsid: z.string().min(1).max(60).default("demo-user-1"),
  text: z.string().min(1).max(900),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  await requireAdmin();
  if (process.env.NODE_ENV === "production" || process.env.ENABLE_DEV_SIMULATOR !== "true") {
    throw new AppError("FORBIDDEN", "The webhook simulator is disabled", {
      reason: "ENABLE_DEV_SIMULATOR is not 'true' or the app runs in production.",
      fix: "Only use the simulator in local development.",
    });
  }

  const body = await parseBody(req, schema);
  const account = await prisma.instagramAccount.findUnique({ where: { id: body.accountId } });
  if (!account) throw notFound("Instagram account");

  const mid = `sim-${sha256Hex(`${body.igsid}:${Date.now()}:${Math.random()}`).slice(0, 24)}`;
  const payload = {
    object: "instagram",
    entry: [
      {
        id: account.igUserId,
        time: Date.now(),
        messaging: [
          {
            sender: { id: body.igsid },
            recipient: { id: account.igUserId },
            timestamp: Date.now(),
            message: { mid, text: body.text },
          },
        ],
      },
    ],
  };

  const event = await prisma.webhookEvent.create({
    data: {
      object: "instagram",
      dedupeKey: `msg:${mid}`,
      payload,
      signatureValid: true,
      status: "QUEUED",
    },
  });
  await enqueue("webhook.process", { webhookEventId: event.id }, { priority: 10 });
  return ok({ simulated: true, mid, note: "Processed by the worker (npm run worker) or inline queue (QUEUE_INLINE=true)." });
});
