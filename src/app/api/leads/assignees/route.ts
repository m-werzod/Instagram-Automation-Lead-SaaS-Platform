import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { validationError } from "@/lib/errors";

/** Who a lead on this account may be assigned to: staff (unrestricted) + any USER granted this account. */
export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId");
  if (!accountId) throw validationError("accountId is required");
  await assertAccountAccess(auth, accountId);

  const admins = await prisma.admin.findMany({
    where: {
      isActive: true,
      OR: [{ role: { in: ["OWNER", "ADMIN"] } }, { accountAccess: { some: { accountId } } }],
    },
    select: { id: true, name: true, login: true, role: true },
    orderBy: { name: "asc" },
  });
  return ok({ admins });
});
