import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { fetchCampaignStatus } from "@/lib/meta/marketing";
import type { Prisma } from "@prisma/client";

export const GET = route(async (req: NextRequest, ctx: RouteCtx) => {
  await requireAdmin();
  const { id } = await ctx.params;
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: {
      account: true,
      content: { select: { id: true, caption: true, thumbnailUrl: true, permalink: true, mediaProductType: true } },
      _count: { select: { leads: true } },
    },
  });
  if (!campaign) throw notFound("Campaign");

  let live = null;
  if (campaign.metaCampaignId && !campaign.account.isDemo && req.nextUrl.searchParams.get("live") === "1") {
    try {
      live = await fetchCampaignStatus(campaign.account, campaign);
    } catch {
      live = null; // surfaced separately via lastError; page still renders
    }
  }
  return ok({ campaign: { ...campaign, account: { id: campaign.account.id, username: campaign.account.username, connectionMode: campaign.account.connectionMode, adAccountId: campaign.account.adAccountId, isDemo: campaign.account.isDemo } }, live });
});

const updateSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  dailyBudgetCents: z.number().int().min(100).max(100_000_000).nullable().optional(),
  lifetimeBudgetCents: z.number().int().min(100).max(1_000_000_000).nullable().optional(),
  startTime: z.string().datetime().nullable().optional(),
  endTime: z.string().datetime().nullable().optional(),
  targeting: z
    .object({
      countries: z.array(z.string().length(2)).max(10).optional(),
      ageMin: z.number().int().min(18).max(65).optional(),
      ageMax: z.number().int().min(18).max(65).optional(),
      genders: z.array(z.number().int().min(1).max(2)).optional(),
      instagramPositions: z.array(z.enum(["stream", "story", "explore", "reels"])).optional(),
    })
    .nullable()
    .optional(),
  ctaType: z.string().max(40).nullable().optional(),
  destinationType: z.enum(["WEBSITE", "INSTAGRAM_DIRECT", "LEAD_FORM"]).nullable().optional(),
  destinationUrl: z.string().url().nullable().optional(),
  contentId: z.string().nullable().optional(),
  creativeSpec: z.object({ message: z.string().max(2000).optional(), imageUrl: z.string().url().optional() }).nullable().optional(),
  status: z.enum(["ARCHIVED"]).optional(), // only archiving via generic PATCH
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;
  const body = await parseBody(req, updateSchema);

  const existing = await prisma.campaign.findUnique({ where: { id } });
  if (!existing) throw notFound("Campaign");
  if (existing.status === "ACTIVE" && body.status !== "ARCHIVED") {
    throw validationError("Pause the campaign before editing it");
  }

  const campaign = await prisma.campaign.update({
    where: { id },
    data: {
      ...body,
      startTime: body.startTime !== undefined ? (body.startTime ? new Date(body.startTime) : null) : undefined,
      endTime: body.endTime !== undefined ? (body.endTime ? new Date(body.endTime) : null) : undefined,
      targeting: body.targeting !== undefined ? ((body.targeting ?? undefined) as Prisma.InputJsonValue | undefined) : undefined,
      creativeSpec:
        body.creativeSpec !== undefined ? ((body.creativeSpec ?? undefined) as Prisma.InputJsonValue | undefined) : undefined,
    },
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPDATED_CAMPAIGN,
    resourceType: "campaign",
    resourceId: id,
    before: { budget: existing.dailyBudgetCents, status: existing.status },
    after: { budget: campaign.dailyBudgetCents, status: campaign.status },
    ip: clientIp(req),
  });
  return ok({ campaign });
});
