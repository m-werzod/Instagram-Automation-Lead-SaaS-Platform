import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";

export const GET = route(async (req: NextRequest) => {
  await requireAdmin();
  const sp = req.nextUrl.searchParams;
  const action = sp.get("action") ?? undefined;
  const adminId = sp.get("adminId") ?? undefined;
  const take = Math.min(200, Number(sp.get("take") ?? 100));
  const cursor = sp.get("cursor") ?? undefined;

  const logs = await prisma.auditLog.findMany({
    where: {
      ...(action ? { action: { contains: action.toUpperCase() } } : {}),
      ...(adminId ? { adminId } : {}),
    },
    include: { admin: { select: { email: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = logs.length > take;
  return ok({
    logs: logs.slice(0, take),
    nextCursor: hasMore ? logs[take - 1]!.id : null,
  });
});
