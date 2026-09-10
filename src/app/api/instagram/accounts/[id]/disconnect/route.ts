import { NextRequest } from "next/server";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { disconnectAccount } from "@/lib/meta/accounts";
import { audit, AuditActions } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/errors";

export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");

  const account = await prisma.instagramAccount.findUnique({ where: { id } });
  if (!account) throw notFound("Instagram account");

  await disconnectAccount(id);
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.DISCONNECTED_INSTAGRAM,
    resourceType: "instagram_account",
    resourceId: id,
    before: { status: account.status },
    after: { status: "DISCONNECTED", username: account.username },
    ip: clientIp(req),
  });
  return ok({ disconnected: true });
});
