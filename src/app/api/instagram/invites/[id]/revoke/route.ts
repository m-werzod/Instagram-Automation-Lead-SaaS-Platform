import { NextRequest } from "next/server";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireStaff } from "@/lib/auth/guard";
import { revokeInvite } from "@/lib/meta/invites";
import { prisma } from "@/lib/prisma";
import { notFound } from "@/lib/errors";
import { audit } from "@/lib/audit";

/** Kill a connect link before it is used — the link is a bearer credential. */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireStaff();
  const id = await pathParam(ctx, "id");

  const invite = await prisma.connectInvite.findUnique({ where: { id } });
  if (!invite) throw notFound("Invitation");

  await revokeInvite(id);
  await audit({
    adminId: auth.admin.id,
    action: "REVOKED_CONNECT_INVITE",
    resourceType: "connect_invite",
    resourceId: id,
    before: { label: invite.label },
    ip: clientIp(req),
  });
  return ok({ revoked: true });
});
