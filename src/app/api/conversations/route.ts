import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId") ?? undefined;
  const status = sp.get("status") ?? undefined; // OPEN | HUMAN | CLOSED
  const q = sp.get("q") ?? undefined;

  const conversations = await prisma.conversation.findMany({
    where: {
      ...(await accountScope(auth, accountId)),
      ...(status === "OPEN" || status === "HUMAN" || status === "CLOSED" ? { status } : {}),
      ...(q ? { OR: [{ username: { contains: q, mode: "insensitive" } }, { igsid: { contains: q } }] } : {}),
    },
    include: {
      account: { select: { username: true } },
      agent: { select: { id: true, name: true } },
      _count: { select: { messages: true } },
    },
    orderBy: { lastMessageAt: "desc" },
    take: 200,
  });
  return ok({ conversations });
});
