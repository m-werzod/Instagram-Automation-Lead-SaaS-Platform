import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";

const DEFAULT_TAKE = 50;
const MAX_TAKE = 100;

/**
 * ?take reaches Prisma directly, and findMany throws on NaN or a negative
 * number — a hand-edited URL used to answer 500. Unparseable falls back to the
 * default; anything parseable is clamped into the page-size window.
 */
const takeSchema = z.coerce
  .number()
  .int()
  .catch(DEFAULT_TAKE)
  .transform((n) => Math.min(MAX_TAKE, Math.max(1, n)));

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId") ?? undefined;
  const type = sp.get("type") ?? undefined; // REELS | FEED | STORY
  // `||`, not `??`: ?take= (blank) coerces to 0 and would clamp to a single row.
  const take = takeSchema.parse(sp.get("take") || DEFAULT_TAKE);

  const items = await prisma.contentItem.findMany({
    where: {
      ...(await accountScope(auth, accountId)),
      ...(type ? { mediaProductType: type } : {}),
    },
    include: {
      analysis: true,
      account: { select: { username: true } },
      ctaConfigs: { select: { id: true, name: true, kind: true, enabled: true } },
      _count: { select: { campaigns: true, leads: true } },
    },
    orderBy: { timestamp: "desc" },
    take,
  });
  return ok({ items });
});
