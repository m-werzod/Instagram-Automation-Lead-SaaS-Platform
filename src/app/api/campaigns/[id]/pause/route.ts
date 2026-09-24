import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { campaignPauseProblem, pauseCampaignInMeta } from "@/lib/meta/marketing";

export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { account: true } });
  if (!campaign) throw notFound("Campaign");
  await assertAccountAccess(auth, campaign.accountId);

  const problem = campaignPauseProblem(campaign.status);
  if (problem) throw validationError(problem);

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
