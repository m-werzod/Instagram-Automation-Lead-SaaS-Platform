import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope, assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { SUPPORTED_CTA_TYPES, SUPPORTED_OBJECTIVES, INSTAGRAM_POSITIONS, OBJECTIVE_CONFIG } from "@/lib/meta/marketing";
import { campaignFieldsProblem, campaignFieldsSchema } from "@/lib/validation/campaign";
import type { Prisma } from "@prisma/client";

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId") ?? undefined;
  const campaigns = await prisma.campaign.findMany({
    where: await accountScope(auth, accountId),
    include: {
      account: { select: { username: true, connectionMode: true, adAccountId: true, fbPageId: true } },
      content: { select: { id: true, caption: true, thumbnailUrl: true, mediaUrl: true, mediaProductType: true, permalink: true } },
      _count: { select: { leads: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return ok({
    campaigns,
    options: {
      objectives: SUPPORTED_OBJECTIVES.map((o) => ({ ...o, needsPage: OBJECTIVE_CONFIG[o.value].needsPage })),
      ctaTypes: SUPPORTED_CTA_TYPES,
      instagramPositions: INSTAGRAM_POSITIONS,
    },
  });
});

const createSchema = campaignFieldsSchema.extend({ accountId: z.string().min(1) });

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, createSchema);

  const account = await prisma.instagramAccount.findUnique({ where: { id: body.accountId } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  const problem = campaignFieldsProblem(body);
  if (problem) throw validationError(problem);

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
      metaFormId: body.metaFormId ?? null,
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
    after: { name: campaign.name, objective: campaign.objective, dailyBudgetCents: campaign.dailyBudgetCents, lifetimeBudgetCents: campaign.lifetimeBudgetCents },
    ip: clientIp(req),
  });
  return ok({ campaign });
});
