import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin, requireStaff } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { detectCapabilities } from "@/lib/meta/capabilities";

export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const acc = await prisma.instagramAccount.findUnique({
    where: { id },
    include: { permissions: true, tokens: { orderBy: { issuedAt: "desc" } } },
  });
  if (!acc) throw notFound("Instagram account");
  await assertAccountAccess(auth, acc.id);
  return ok({
    account: {
      ...acc,
      tokens: acc.tokens.map((t) => ({
        id: t.id,
        kind: t.kind,
        status: t.status,
        scopes: t.scopes,
        issuedAt: t.issuedAt,
        expiresAt: t.expiresAt,
        lastRefreshAt: t.lastRefreshAt,
        lastCheckedAt: t.lastCheckedAt,
        // encrypted blob intentionally omitted — tokens never reach the browser
      })),
    },
    capabilities: detectCapabilities(acc),
  });
});

const patchSchema = z.object({
  adAccountId: z.string().regex(/^act_\d+$/, "Ad account id must look like act_123456789").nullable().optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireStaff(); // linking an ad account is a billing relationship — staff only
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, patchSchema);

  const acc = await prisma.instagramAccount.findUnique({ where: { id } });
  if (!acc) throw notFound("Instagram account");

  const updated = await prisma.instagramAccount.update({
    where: { id },
    data: { ...(body.adAccountId !== undefined ? { adAccountId: body.adAccountId } : {}) },
  });

  await audit({
    adminId: auth.admin.id,
    action: "UPDATED_INSTAGRAM_ACCOUNT",
    resourceType: "instagram_account",
    resourceId: id,
    before: { adAccountId: acc.adAccountId },
    after: { adAccountId: updated.adAccountId },
    ip: clientIp(req),
  });
  return ok({ account: { id: updated.id, adAccountId: updated.adAccountId } });
});
