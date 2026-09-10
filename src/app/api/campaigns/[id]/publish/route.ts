import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { activateCampaignInMeta } from "@/lib/meta/marketing";
import { getGlobalSettings } from "@/lib/settings";
import { AppError } from "@/lib/errors";
import { centsToMoney } from "@/lib/utils";

const publishSchema = z.object({
  /** The admin must type the campaign name to confirm real spend (spec §16). */
  confirmName: z.string(),
  acknowledgeSpend: z.literal(true),
});

/** ACTIVATE the campaign in Meta = start spending real money. */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;
  const body = await parseBody(req, publishSchema);

  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { account: true } });
  if (!campaign) throw notFound("Campaign");
  if (campaign.status !== "CREATED" && campaign.status !== "PAUSED") {
    throw validationError(`Campaign must be created in Meta (PAUSED) first — current status: ${campaign.status}`);
  }
  if (body.confirmName.trim() !== campaign.name.trim()) {
    throw validationError("Confirmation failed: type the exact campaign name to publish");
  }

  // AI-created campaigns additionally require the global auto-launch enable (spec §16)
  if (campaign.createdByAi) {
    const settings = await getGlobalSettings();
    if (!settings.autoCampaignLaunchEnabled) {
      throw new AppError("AUTOMATION_DISABLED", "Automatic Campaign Launch is OFF", {
        reason: "This campaign was drafted by the AI. Publishing AI-drafted campaigns requires the global 'Automatic Campaign Launch' toggle.",
        fix: "Settings → Global switches → enable Automatic Campaign Launch, or duplicate this draft as an admin campaign.",
      });
    }
  }

  await activateCampaignInMeta(campaign.account, campaign);
  const updated = await prisma.campaign.update({
    where: { id },
    data: { status: "ACTIVE", publishedAt: new Date(), publishedByAdminId: auth.admin.id, lastError: null },
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.PUBLISHED_CAMPAIGN,
    resourceType: "campaign",
    resourceId: id,
    after: {
      name: campaign.name,
      dailyBudget: centsToMoney(campaign.dailyBudgetCents, campaign.currency),
      lifetimeBudget: centsToMoney(campaign.lifetimeBudgetCents, campaign.currency),
      metaCampaignId: campaign.metaCampaignId,
      SPEND_AUTHORIZED: true,
    },
    ip: clientIp(req),
  });
  return ok({ campaign: updated });
});
