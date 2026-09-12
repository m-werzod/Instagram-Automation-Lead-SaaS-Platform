import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { SUPPORTED_CTA_TYPES } from "@/lib/meta/marketing";
import { campaignFieldsProblem, campaignFieldsSchema } from "@/lib/validation/campaign";
import { Prisma } from "@prisma/client";
import { z } from "zod";

export const GET = route(async (_req: NextRequest, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      account: true,
      content: { select: { id: true, caption: true, thumbnailUrl: true, mediaUrl: true, permalink: true, mediaProductType: true } },
      _count: { select: { leads: true } },
    },
  });
  if (!campaign) throw notFound("Campaign");
  await assertAccountAccess(auth, campaign.accountId);
  return ok({
    campaign: {
      ...campaign,
      account: {
        id: campaign.account.id,
        username: campaign.account.username,
        connectionMode: campaign.account.connectionMode,
        adAccountId: campaign.account.adAccountId,
        fbPageId: campaign.account.fbPageId,
        isDemo: campaign.account.isDemo,
      },
    },
  });
});

/** Everything is editable while the campaign is local; once it exists in Meta only archiving is allowed here. */
const updateSchema = campaignFieldsSchema.partial().extend({
  status: z.enum(["ARCHIVED"]).optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, updateSchema);

  const existing = await prisma.campaign.findUnique({ where: { id } });
  if (!existing) throw notFound("Campaign");
  await assertAccountAccess(auth, existing.accountId);

  const editable = existing.status === "DRAFT" || existing.status === "READY" || existing.status === "ERROR";
  const onlyArchiving = Object.keys(body).every((k) => k === "status");
  if (!editable && !onlyArchiving) {
    throw validationError(
      existing.status === "ACTIVE"
        ? "Pause the campaign before editing it — and note that budget/targeting of a campaign already in Meta must be edited in Ads Manager"
        : "This campaign already exists in Meta; edit budget and targeting in Meta Ads Manager",
    );
  }

  if (body.ctaType && !SUPPORTED_CTA_TYPES.some((c) => c.value === body.ctaType)) body.ctaType = null;
  if (body.contentId) {
    const content = await prisma.contentItem.findFirst({ where: { id: body.contentId, accountId: existing.accountId } });
    if (!content) throw notFound("Selected content (must belong to the same account)");
  }
  if (editable && !onlyArchiving) {
    const merged = {
      dailyBudgetCents: body.dailyBudgetCents !== undefined ? body.dailyBudgetCents : existing.dailyBudgetCents,
      lifetimeBudgetCents: body.lifetimeBudgetCents !== undefined ? body.lifetimeBudgetCents : existing.lifetimeBudgetCents,
      startTime: body.startTime !== undefined ? body.startTime : existing.startTime?.toISOString() ?? null,
      endTime: body.endTime !== undefined ? body.endTime : existing.endTime?.toISOString() ?? null,
    };
    const problem = campaignFieldsProblem(merged);
    if (problem) throw validationError(problem);
  }

  const { targeting, creativeSpec, startTime, endTime, ...rest } = body;
  const campaign = await prisma.campaign.update({
    where: { id },
    data: {
      ...rest,
      startTime: startTime !== undefined ? (startTime ? new Date(startTime) : null) : undefined,
      endTime: endTime !== undefined ? (endTime ? new Date(endTime) : null) : undefined,
      targeting: targeting !== undefined ? ((targeting ?? undefined) as Prisma.InputJsonValue | undefined) : undefined,
      creativeSpec: creativeSpec !== undefined ? ((creativeSpec ?? undefined) as Prisma.InputJsonValue | undefined) : undefined,
      // targeting changed → the previous estimate no longer describes this audience
      ...(targeting !== undefined ? { estimate: Prisma.JsonNull } : {}),
    },
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPDATED_CAMPAIGN,
    resourceType: "campaign",
    resourceId: id,
    before: { budget: existing.dailyBudgetCents ?? existing.lifetimeBudgetCents, status: existing.status },
    after: { budget: campaign.dailyBudgetCents ?? campaign.lifetimeBudgetCents, status: campaign.status },
    ip: clientIp(req),
  });
  return ok({ campaign });
});

export const DELETE = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const existing = await prisma.campaign.findUnique({ where: { id } });
  if (!existing) throw notFound("Campaign");
  await assertAccountAccess(auth, existing.accountId);
  if (existing.metaCampaignId) throw validationError("This campaign exists in Meta — stop it, then archive it; deletion is only for local drafts");
  await prisma.campaign.delete({ where: { id } });
  await audit({ adminId: auth.admin.id, action: "DELETED_CAMPAIGN_DRAFT", resourceType: "campaign", resourceId: id, before: { name: existing.name }, ip: clientIp(req) });
  return ok({ deleted: true });
});
