import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, enforceRateLimit, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { notFound } from "@/lib/errors";
import { analyzeContent } from "@/lib/content/analysis";
import { LIMITS } from "@/lib/rate-limit";
import type { RouteCtx } from "@/lib/api";

export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  enforceRateLimit(`ai:${auth.admin.id}`, LIMITS.AI.limit, LIMITS.AI.windowMs);
  const id = await pathParam(ctx, "id");
  const item = await prisma.contentItem.findUnique({ where: { id }, select: { accountId: true } });
  if (!item) throw notFound("Content item");
  await assertAccountAccess(auth, item.accountId);
  const analysis = await analyzeContent(id);
  return ok({ analysis });
});
