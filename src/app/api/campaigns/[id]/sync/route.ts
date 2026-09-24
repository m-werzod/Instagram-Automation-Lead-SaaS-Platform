import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { notFound, validationError } from "@/lib/errors";
import { syncCampaignFromMeta } from "@/lib/meta/marketing";

/** Pull status, spend, results and Meta's ad review verdict right now (the hourly job does the same). */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { account: true } });
  if (!campaign) throw notFound("Campaign");
  await assertAccountAccess(auth, campaign.accountId);
  if (!campaign.metaCampaignId) throw validationError("Nothing to sync — the campaign has not been created in Meta yet");
  if (campaign.account.isDemo) throw validationError("Demo campaigns have no Meta data");

  const result = await syncCampaignFromMeta(campaign.account, campaign);
  const fresh = await prisma.campaign.findUniqueOrThrow({ where: { id } });
  return ok({
    campaign: fresh,
    live: result.status,
    insights: result.insights,
    // null means Meta said nothing this time (no ad yet, or the read failed) —
    // the stored verdict, shown from `campaign`, is the last thing Meta did say.
    review: result.review ? { ...result.review, syncedAt: fresh.reviewSyncedAt } : null,
  });
});
