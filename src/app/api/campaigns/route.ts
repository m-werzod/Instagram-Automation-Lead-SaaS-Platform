import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope, assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { SUPPORTED_CTA_TYPES, SUPPORTED_OBJECTIVES, INSTAGRAM_POSITIONS } from "@/lib/meta/marketing";
import type { Prisma } from "@prisma/client";

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId") ?? undefined;
  const campaigns = await prisma.campaign.findMany({
    where: await accountScope(auth, accountId),
    include: {
      account: { select: { username: true, connectionMode: true, adAccountId: true } },
      content: { select: { id: true, caption: true, thumbnailUrl: true, mediaProductType: true } },
      _count: { select: { leads: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return ok({
    campaigns,
    options: {
      objectives: SUPPORTED_OBJECTIVES,
      ctaTypes: SUPPORTED_CTA_TYPES,
      instagramPositions: INSTAGRAM_POSITIONS,
    },
  });
});

const targetingSchema = z.object({
  countries: z.array(z.string().length(2)).max(10).optional(),
  ageMin: z.number().int().min(18).max(65).optional(),
  ageMax: z.number().int().min(18).max(65).optional(),
  genders: z.array(z.number().int().min(1).max(2)).optional(),
  instagramPositions: z.array(z.enum(["stream", "story", "explore", "reels"])).optional(),
});

const createSchema = z.object({
  accountId: z.string().min(1),
  name: z.string().min(1).max(150),
  objective: z.enum(["OUTCOME_TRAFFIC", "OUTCOME_ENGAGEMENT", "OUTCOME_LEADS", "OUTCOME_AWARENESS"]),
  dailyBudgetCents: z.number().int().min(100).max(100_000_000).nullable().optional(),
  lifetimeBudgetCents: z.number().int().min(100).max(1_000_000_000).nullable().optional(),
  currency: z.string().length(3).default("USD"),
  startTime: z.string().datetime().nullable().optional(),
  endTime: z.string().datetime().nullable().optional(),
  targeting: targetingSchema.nullable().optional(),
  ctaType: z.string().max(40).nullable().optional(),
  destinationType: z.enum(["WEBSITE", "INSTAGRAM_DIRECT", "LEAD_FORM"]).nullable().optional(),
  destinationUrl: z.string().url().nullable().optional(),
  leadFlowId: z.string().nullable().optional(),
  contentId: z.string().nullable().optional(),
  creativeSpec: z.object({ message: z.string().max(2000).optional(), imageUrl: z.string().url().optional() }).nullable().optional(),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, createSchema);

  const account = await prisma.instagramAccount.findUnique({ where: { id: body.accountId } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  if (body.ctaType && !SUPPORTED_CTA_TYPES.some((c) => c.value === body.ctaType)) {
    body.ctaType = null;
  }
  if (body.contentId) {
    const content = await prisma.contentItem.findFirst({ where: { id: body.contentId, accountId: account.id } });
    if (!content) throw notFound("Selected content (must belong to the same account)");
  }

  const campaign = await prisma.campaign.create({
    data: {
      accountId: body.accountId,
      name: body.name,
      objective: body.objective,
      status: "DRAFT",
      dailyBudgetCents: body.dailyBudgetCents ?? null,
      lifetimeBudgetCents: body.lifetimeBudgetCents ?? null,
      currency: body.currency,
      startTime: body.startTime ? new Date(body.startTime) : null,
      endTime: body.endTime ? new Date(body.endTime) : null,
      targeting: (body.targeting ?? undefined) as Prisma.InputJsonValue | undefined,
      ctaType: body.ctaType ?? null,
      destinationType: body.destinationType ?? null,
      destinationUrl: body.destinationUrl ?? null,
      leadFlowId: body.leadFlowId ?? null,
      contentId: body.contentId ?? null,
      creativeSpec: (body.creativeSpec ?? undefined) as Prisma.InputJsonValue | undefined,
      createdByAdminId: auth.admin.id,
      createdByAi: false,
    },
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CREATED_CAMPAIGN,
    resourceType: "campaign",
    resourceId: campaign.id,
    after: { name: campaign.name, objective: campaign.objective, dailyBudgetCents: campaign.dailyBudgetCents },
    ip: clientIp(req),
  });
  return ok({ campaign });
});
