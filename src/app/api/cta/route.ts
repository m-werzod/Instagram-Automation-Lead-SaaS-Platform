import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope, assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { SUPPORTED_CTA_TYPES } from "@/lib/meta/marketing";
import { randomToken } from "@/lib/crypto";
import type { Prisma } from "@prisma/client";

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId") ?? undefined;
  const contentId = sp.get("contentId") ?? undefined;
  const ctas = await prisma.ctaConfig.findMany({
    where: { ...(await accountScope(auth, accountId)), ...(contentId ? { contentId } : {}) },
    include: {
      account: { select: { username: true, connectionMode: true } },
      content: { select: { id: true, caption: true, thumbnailUrl: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  return ok({ ctas, nativeCtaTypes: SUPPORTED_CTA_TYPES });
});

const overlaySchema = z.object({
  text: z.string().min(1).max(60),
  position: z.enum(["bottom", "top", "center"]),
  bgColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

const createSchema = z.object({
  accountId: z.string().min(1),
  contentId: z.string().nullable().optional(),
  name: z.string().min(1).max(120),
  kind: z.enum(["AD_NATIVE", "CREATIVE_OVERLAY", "EXTERNAL_LINK", "MESSAGING"]),
  enabled: z.boolean().default(true),
  ctaType: z.string().max(40).nullable().optional(),
  url: z.string().url().nullable().optional(),
  leadFlowId: z.string().nullable().optional(),
  overlaySpec: overlaySchema.nullable().optional(),
  messagingKeyword: z.string().max(60).nullable().optional(),
  createLandingPage: z.boolean().default(false),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, createSchema);

  const account = await prisma.instagramAccount.findUnique({ where: { id: body.accountId } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  // Honest kind-specific validation (spec §12–13):
  if (body.kind === "AD_NATIVE") {
    // A native button only renders on a paid placement, so an ad account must exist.
    if (!account.adAccountId) {
      throw validationError(
        "A native Meta button (Sign Up, Learn More…) only exists on ads, so this account needs a Meta ad account first. Use 'Connect with Facebook (ads)' on the Integrations page — or pick External Link / Messaging to capture leads without paying.",
      );
    }
    if (!body.ctaType || !SUPPORTED_CTA_TYPES.some((c) => c.value === body.ctaType)) {
      throw validationError(`AD_NATIVE requires a supported ctaType: ${SUPPORTED_CTA_TYPES.map((c) => c.value).join(", ")}`);
    }
  }
  if (body.kind === "CREATIVE_OVERLAY" && !body.overlaySpec) {
    throw validationError("CREATIVE_OVERLAY requires overlaySpec (text, position, colors)");
  }
  if (body.kind === "MESSAGING" && !body.messagingKeyword && !body.leadFlowId) {
    throw validationError("MESSAGING CTA needs a keyword and/or a lead flow");
  }
  if (body.leadFlowId) {
    const flow = await prisma.leadFlow.findFirst({ where: { id: body.leadFlowId, accountId: body.accountId } });
    if (!flow) throw validationError("Lead flow does not belong to this account");
  }

  let landingSlug: string | null = null;
  if (body.kind === "EXTERNAL_LINK" && body.createLandingPage) {
    if (!body.leadFlowId) throw validationError("A hosted landing page needs a lead flow (its questions become the form)");
    landingSlug = randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10) || "form";
  } else if (body.kind === "EXTERNAL_LINK" && !body.url) {
    throw validationError("EXTERNAL_LINK requires a URL (or enable the hosted landing page)");
  }

  const cta = await prisma.ctaConfig.create({
    data: {
      accountId: body.accountId,
      contentId: body.contentId ?? null,
      name: body.name,
      kind: body.kind,
      enabled: body.enabled,
      ctaType: body.ctaType ?? null,
      url: body.url ?? null,
      landingSlug,
      leadFlowId: body.leadFlowId ?? null,
      overlaySpec: (body.overlaySpec ?? undefined) as Prisma.InputJsonValue | undefined,
      messagingKeyword: body.messagingKeyword?.toLowerCase() ?? null,
    },
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CREATED_CTA,
    resourceType: "cta_config",
    resourceId: cta.id,
    after: { name: cta.name, kind: cta.kind },
    ip: clientIp(req),
  });
  return ok({ cta });
});
