import { NextRequest } from "next/server";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/errors";
import { syncMedia } from "@/lib/meta/media";
import { audit, AuditActions } from "@/lib/audit";

export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const account = await prisma.instagramAccount.findUnique({ where: { id } });
  if (!account) throw notFound("Instagram account");
  if (account.isDemo) {
    const count = await prisma.contentItem.count({ where: { accountId: id } });
    return ok({ synced: count, demo: true });
  }

  const synced = await syncMedia(account, 100);
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.SYNCED_CONTENT,
    resourceType: "instagram_account",
    resourceId: id,
    after: { synced },
    ip: clientIp(req),
  });
  return ok({ synced });
});
