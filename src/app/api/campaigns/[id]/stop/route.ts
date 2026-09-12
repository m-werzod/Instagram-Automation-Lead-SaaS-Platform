import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { stopCampaignInMeta } from "@/lib/meta/marketing";

/** STOP: archive in Meta (delivery ends permanently) and locally. Pausing is the reversible alternative. */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { account: true } });
  if (!campaign) throw notFound("Campaign");
  await assertAccountAccess(auth, campaign.accountId);
  if (campaign.status === "ARCHIVED") return ok({ campaign });
  if (!campaign.metaCampaignId) throw validationError("This campaign was never created in Meta — archive the draft instead");

  if (!campaign.account.isDemo) await stopCampaignInMeta(campaign.account, campaign);
  const updated = await prisma.campaign.update({ where: { id }, data: { status: "ARCHIVED", stoppedAt: new Date() } });
  await audit({
    adminId: auth.admin.id,
    action: "STOPPED_CAMPAIGN",
    resourceType: "campaign",
    resourceId: id,
    before: { status: campaign.status },
    after: { status: "ARCHIVED", metaCampaignId: campaign.metaCampaignId },
    ip: clientIp(req),
  });
  return ok({ campaign: updated });
});
