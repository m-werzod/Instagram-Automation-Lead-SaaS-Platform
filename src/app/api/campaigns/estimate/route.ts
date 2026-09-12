import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, enforceRateLimit } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { notFound } from "@/lib/errors";
import { fetchReachEstimate } from "@/lib/meta/marketing";
import { targetingSchema } from "@/lib/validation/campaign";
import type { Prisma } from "@prisma/client";

/**
 * Meta's own audience estimate for a targeting spec (/act_{id}/reachestimate).
 * When Meta has nothing, the answer is "unavailable" with the reason — the
 * platform never computes or invents a number. Optionally stored on a draft.
 */
const schema = z.object({
  accountId: z.string().min(1),
  targeting: targetingSchema,
  campaignId: z.string().optional(),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  enforceRateLimit(`estimate:${auth.admin.id}`, 20, 60_000);
  const body = await parseBody(req, schema);

  const account = await prisma.instagramAccount.findUnique({ where: { id: body.accountId } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  if (account.isDemo) {
    return ok({ estimate: { available: false, reason: "Demo account — Meta estimates are not fabricated for demo data." } });
  }

  const estimate = await fetchReachEstimate(account, body.targeting);
  if (body.campaignId) {
    await prisma.campaign
      .updateMany({ where: { id: body.campaignId, accountId: account.id }, data: { estimate: estimate as unknown as Prisma.InputJsonValue } })
      .catch(() => undefined);
  }
  return ok({ estimate });
});
