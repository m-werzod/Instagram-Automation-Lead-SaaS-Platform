import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { notFound } from "@/lib/errors";
import { fetchMediaInsights } from "@/lib/meta/media";
import type { Prisma } from "@prisma/client";

export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const content = await prisma.contentItem.findUnique({ where: { id }, include: { account: true } });
  if (!content) throw notFound("Content item");
  await assertAccountAccess(auth, content.accountId);
  if (content.account.isDemo) return ok({ insights: content.insights, demo: true });

  const insights = await fetchMediaInsights(content.account, content.mediaId, content.mediaProductType);
  if (insights) {
    await prisma.contentItem.update({
      where: { id },
      data: { insights: insights as Prisma.InputJsonValue },
    });
  }
  return ok({ insights });
});
