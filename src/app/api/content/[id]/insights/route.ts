import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { AppError, notFound } from "@/lib/errors";
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

  const result = await fetchMediaInsights(content.account, content.mediaId, content.mediaProductType);
  if (!result.ok) {
    // An unavailable metric set used to return ok({ insights: null }), which the
    // UI reported as a successful refresh. Say why instead.
    if (result.error instanceof AppError) throw result.error;
    throw new AppError("META_UNSUPPORTED", "Instagram has no insights for this post", {
      reason: result.reason,
      fix: "Insights need a Business or Creator account, and a story only reports for 24 hours after it is posted.",
    });
  }

  await prisma.contentItem.update({
    where: { id },
    data: { insights: result.metrics as Prisma.InputJsonValue },
  });
  return ok({ insights: result.metrics });
});
