import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId") ?? undefined;
  const type = sp.get("type") ?? undefined; // REELS | FEED | STORY
  const take = Math.min(100, Number(sp.get("take") ?? 50));

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
