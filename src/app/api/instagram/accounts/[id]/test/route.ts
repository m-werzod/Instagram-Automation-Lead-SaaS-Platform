import { NextRequest } from "next/server";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { testConnection } from "@/lib/meta/accounts";
import { audit, AuditActions } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/errors";

export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;

  const account = await prisma.instagramAccount.findUnique({ where: { id } });
  if (!account) throw notFound("Instagram account");
  if (account.isDemo) {
    return ok({ result: { ok: true, username: account.username, followers: account.followersCount, demo: true } });
  }

  try {
    const result = await testConnection(id);
    await audit({
      adminId: auth.admin.id,
      action: AuditActions.TESTED_CONNECTION,
      resourceType: "instagram_account",
      resourceId: id,
      after: { ok: true },
      ip: clientIp(req),
    });
    return ok({ result });
  } catch (err) {
    await audit({
      adminId: auth.admin.id,
      action: AuditActions.TESTED_CONNECTION,
      resourceType: "instagram_account",
      resourceId: id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      ip: clientIp(req),
    });
    throw err;
  }
});
