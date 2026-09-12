import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError, metaUnsupported } from "@/lib/errors";
import { createCampaignInMeta } from "@/lib/meta/marketing";
import { assertCampaignFeePaid, campaignFeeStatus } from "@/lib/billing/service";
import { paymentsConfigured } from "@/lib/billing/config";

/**
 * Create the campaign chain in Meta — everything PAUSED. No Meta money is spent
 * by this action (activation is a separate, confirmed publish step). When the
 * platform charges a service fee, that fee must be SUCCEEDED first; the fee is
 * the platform's — Meta's ad spend is billed by Meta to the ad account.
 */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");

  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { account: true } });
  if (!campaign) throw notFound("Campaign");
  await assertAccountAccess(auth, campaign.accountId);
  if (campaign.account.isDemo) {
    throw metaUnsupported("Demo account", "Demo data cannot create real Meta campaigns.", "Connect a real Instagram account.");
  }
  if (campaign.status !== "DRAFT" && campaign.status !== "READY" && campaign.status !== "ERROR") {
    throw validationError(`Campaign is ${campaign.status} — it already exists in Meta`);
  }

  // Platform fee gate (only when pricing defines one AND billing is configured;
  // a configured fee with no payment provider blocks with a clear message too).
  const fee = await campaignFeeStatus(campaign.id);
  if (fee.required && !paymentsConfigured()) {
    throw validationError("A platform fee is configured but payments are not set up — set PAYMENT_SECRET_KEY or set the campaign fee to 0 in Billing → Pricing");
  }
  assertCampaignFeePaid(fee);

  try {
    const ids = await createCampaignInMeta(campaign.account, campaign);
    const updated = await prisma.campaign.update({
      where: { id },
      data: { ...ids, status: "CREATED", lastError: null },
    });
    await audit({
      adminId: auth.admin.id,
      action: AuditActions.CREATED_CAMPAIGN_IN_META,
      resourceType: "campaign",
      resourceId: id,
      after: { metaCampaignId: ids.metaCampaignId, status: "CREATED (PAUSED in Meta)", platformFeeCents: campaign.platformFeeCents },
      ip: clientIp(req),
    });
    return ok({ campaign: updated });
  } catch (err) {
    await prisma.campaign.update({
      where: { id },
      data: { status: "ERROR", lastError: err instanceof Error ? err.message : String(err) },
    });
    await audit({
      adminId: auth.admin.id,
      action: "META_API_FAILURE",
      resourceType: "campaign",
      resourceId: id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      ip: clientIp(req),
    });
    throw err;
  }
});
