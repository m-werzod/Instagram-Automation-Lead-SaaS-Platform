import { NextRequest } from "next/server";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { resubscribeWebhooks } from "@/lib/meta/accounts";
import { audit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/errors";

/**
 * Retry the Instagram event subscription for an already-connected account.
 *
 * Subscribing is deliberately non-fatal during connect, which leaves a real gap:
 * an account can be fully authorized while no DM or comment ever arrives. Before
 * this, the only way out was to disconnect and re-authorize. It is idempotent —
 * Meta treats a repeat subscribe as a no-op.
 */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");

  const account = await prisma.instagramAccount.findUnique({ where: { id } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);
  if (account.isDemo) {
    await prisma.instagramAccount.update({ where: { id }, data: { webhookSubscribed: true } });
    return ok({ subscribed: true, demo: true });
  }

  try {
    await resubscribeWebhooks(id);
    await audit({
      adminId: auth.admin.id,
      action: "SUBSCRIBED_INSTAGRAM_WEBHOOKS",
      resourceType: "instagram_account",
      resourceId: id,
      after: { webhookSubscribed: true },
      ip: clientIp(req),
    });
    return ok({ subscribed: true });
  } catch (err) {
    await audit({
      adminId: auth.admin.id,
      action: "SUBSCRIBED_INSTAGRAM_WEBHOOKS",
      resourceType: "instagram_account",
      resourceId: id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      ip: clientIp(req),
    });
    throw err;
  }
});
