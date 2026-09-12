import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { notFound } from "@/lib/errors";
import { fetchAdPreview } from "@/lib/meta/marketing";

/** Meta-rendered preview (iframe HTML) of the created ad. Null until the creative exists in Meta. */
export const GET = route(async (req: NextRequest, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { account: true } });
  if (!campaign) throw notFound("Campaign");
  await assertAccountAccess(auth, campaign.accountId);
  if (!campaign.metaCreativeId || campaign.account.isDemo) {
    return ok({ html: null, reason: "Meta renders a preview only after the campaign has been created in Meta." });
  }
  const format = req.nextUrl.searchParams.get("format") === "reels" ? "INSTAGRAM_REELS" : "INSTAGRAM_STANDARD";
  const html = await fetchAdPreview(campaign.account, campaign, format);
  return ok({ html, reason: html ? null : "Meta returned no preview for this creative." });
});
