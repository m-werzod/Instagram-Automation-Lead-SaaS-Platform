import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { coreEnv } from "@/lib/env";
import { randomToken } from "@/lib/crypto";
import { SUPPORTED_CTA_TYPES } from "@/lib/meta/marketing";
import { leadButtonSaveSchema, parseButtonSpec } from "@/lib/validation/leadbutton";
import type { Prisma } from "@prisma/client";

/**
 * The Lead Button — ONE per Instagram account.
 *
 * Under the hood it is a CtaConfig (kind EXTERNAL_LINK + hosted landing page)
 * joined to a LeadFlow (the questions). This endpoint reads and saves the
 * whole thing atomically so the builder page never has to orchestrate three
 * APIs and can never leave half-saved state.
 */

const LEAD_BUTTON_NAME = "Lead Button";

function landingUrlFor(slug: string | null): string | null {
  if (!slug) return null;
  return `${coreEnv().APP_URL}/f/${slug}`;
}

async function loadLeadButton(accountId: string) {
  const config = await prisma.ctaConfig.findFirst({
    where: { accountId, kind: "EXTERNAL_LINK", landingSlug: { not: null }, leadFlowId: { not: null } },
    orderBy: { createdAt: "asc" },
    include: {
      content: { select: { id: true, mediaId: true, caption: true, thumbnailUrl: true, mediaUrl: true, mediaProductType: true, mediaType: true, permalink: true } },
      _count: { select: { leads: true } },
    },
  });
  if (!config) return null;

  const flow = await prisma.leadFlow.findUnique({
    where: { id: config.leadFlowId! },
    include: { questions: { orderBy: { order: "asc" } }, _count: { select: { leads: true } } },
  });
  if (!flow) return null;

  return {
    id: config.id,
    enabled: config.enabled,
    landingSlug: config.landingSlug,
    landingUrl: landingUrlFor(config.landingSlug),
    contentId: config.contentId,
    content: config.content,
    ctaType: config.ctaType,
    buttonSpec: parseButtonSpec(config.buttonSpec),
    headline: flow.name,
    description: flow.description,
    completionMessage: flow.completionMessage,
    triggerKeywords: flow.triggerKeywords,
    flowId: flow.id,
    questions: flow.questions,
    // legacy DM leads carry flowId only; new ones also carry ctaConfigId
    leadsCount: Math.max(config._count.leads, flow._count.leads),
  };
}

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId");
  if (!accountId) throw validationError("accountId is required");
  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId }, select: { id: true, adAccountId: true } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  const leadButton = await loadLeadButton(accountId);
  return ok({
    leadButton,
    nativeCtaTypes: SUPPORTED_CTA_TYPES,
    adsReady: Boolean(account.adAccountId),
  });
});

export const PUT = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, leadButtonSaveSchema);

  const account = await prisma.instagramAccount.findUnique({ where: { id: body.accountId } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  if (body.contentId) {
    const content = await prisma.contentItem.findFirst({ where: { id: body.contentId, accountId: body.accountId } });
    if (!content) throw validationError("Selected content does not belong to this account");
  }
  if (body.ctaType && !SUPPORTED_CTA_TYPES.some((c) => c.value === body.ctaType)) {
    throw validationError(`Unsupported native CTA type: ${body.ctaType}`);
  }

  const existing = await prisma.ctaConfig.findFirst({
    where: { accountId: body.accountId, kind: "EXTERNAL_LINK", landingSlug: { not: null }, leadFlowId: { not: null } },
    orderBy: { createdAt: "asc" },
  });

  const keywords = [...new Set(body.triggerKeywords.map((k) => k.trim().toLowerCase()).filter(Boolean))];

  await prisma.$transaction(async (tx) => {
    let flowId = existing?.leadFlowId ?? null;

    if (flowId) {
      // Replacing questions invalidates in-flight sessions — cancel explicitly
      // (same strategy as /api/lead-flows; Lead.answers snapshots keep history).
      await tx.leadFlowSession.updateMany({ where: { flowId, status: "ACTIVE" }, data: { status: "CANCELLED" } });
      await tx.leadFlowQuestion.deleteMany({ where: { flowId } });
      await tx.leadFlow.update({
        where: { id: flowId },
        data: {
          name: body.headline,
          description: body.description ?? null,
          enabled: body.enabled,
          triggerKeywords: keywords,
          completionMessage: body.completionMessage ?? null,
        },
      });
    } else {
      const flow = await tx.leadFlow.create({
        data: {
          accountId: body.accountId,
          name: body.headline,
          description: body.description ?? null,
          enabled: body.enabled,
          triggerKeywords: keywords,
          completionMessage: body.completionMessage ?? null,
        },
      });
      flowId = flow.id;
    }

    await tx.leadFlowQuestion.createMany({
      data: body.questions.map((q, i) => ({
        flowId: flowId!,
        order: i + 1,
        title: q.title,
        prompt: q.prompt,
        type: q.type,
        required: q.required,
        options: q.options,
        mapTo: q.mapTo ?? null,
        validationRegex: q.validationRegex ?? null,
      })),
    });

    const ctaData = {
      name: LEAD_BUTTON_NAME,
      enabled: body.enabled,
      contentId: body.contentId,
      ctaType: body.ctaType,
      buttonSpec: body.buttonSpec as unknown as Prisma.InputJsonValue,
      leadFlowId: flowId,
    };
    if (existing) {
      await tx.ctaConfig.update({ where: { id: existing.id }, data: ctaData });
    } else {
      const slug = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "form";
      await tx.ctaConfig.create({
        data: { ...ctaData, accountId: body.accountId, kind: "EXTERNAL_LINK", landingSlug: slug },
      });
    }
  });

  const leadButton = await loadLeadButton(body.accountId);
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.SAVED_LEAD_BUTTON,
    resourceType: "cta_config",
    resourceId: leadButton?.id,
    after: { enabled: body.enabled, questions: body.questions.length, target: body.contentId ?? "account" },
    ip: clientIp(req),
  });
  return ok({ leadButton });
});
