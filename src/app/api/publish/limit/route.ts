import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { notFound, validationError } from "@/lib/errors";
import { detectCapabilities } from "@/lib/meta/capabilities";
import { fetchPublishingLimit } from "@/lib/meta/publishing";

/**
 * Can this account publish from here, and how much of Instagram's 100-posts/24h
 * API quota is used? Real numbers from content_publishing_limit, or null with
 * the reason when Meta does not answer.
 */
export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId");
  if (!accountId) throw validationError("accountId is required");
  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId }, include: { permissions: true, tokens: true } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  const cap = detectCapabilities(account).find((c) => c.key === "publishing");
  const available = Boolean(cap?.available) && !account.isDemo;
  const limit = available ? await fetchPublishingLimit(account) : null;
  return ok({
    available,
    reason: account.isDemo ? "Demo account — nothing is ever published for demo data." : cap?.reason ?? null,
    requiredScope: account.connectionMode === "INSTAGRAM_LOGIN" ? "instagram_business_content_publish" : "instagram_content_publish",
    limit,
  });
});
