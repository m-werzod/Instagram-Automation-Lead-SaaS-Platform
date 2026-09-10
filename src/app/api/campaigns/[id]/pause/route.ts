import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { pauseCampaignInMeta } from "@/lib/meta/marketing";

export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { account: true } });
  if (!campaign) throw notFound("Campaign");

  if (campaign.metaCampaignId && !campaign.account.isDemo) {
    await pauseCampaignInMeta(campaign.account, campaign);
  }
  const updated = await prisma.campaign.update({ where: { id }, data: { status: "PAUSED" } });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.PAUSED_CAMPAIGN,
    resourceType: "campaign",
    resourceId: id,
    after: { name: campaign.name },
    ip: clientIp(req),
  });
  return ok({ campaign: updated });
});
