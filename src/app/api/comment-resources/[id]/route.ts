import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";

export const DELETE = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const existing = await prisma.commentResource.findUnique({ where: { id } });
  if (!existing) throw notFound("Resource");
  await assertAccountAccess(auth, existing.accountId);

  // JSON-array partial-match queries are unreliable across Prisma/Postgres
  // versions, so check in process — automation counts per account are small.
  const rules = await prisma.automation.findMany({
    where: { accountId: existing.accountId },
    select: { name: true, actions: true },
  });
  const inUse = rules.find((r) =>
    Array.isArray(r.actions) &&
    r.actions.some((a) => a && typeof a === "object" && "params" in a && (a.params as { resourceId?: string })?.resourceId === id),
  );
  if (inUse) {
    throw validationError(`This resource is used by the rule "${inUse.name}" — remove it from the rule first`);
  }

  await prisma.commentResource.delete({ where: { id } });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.DELETED_COMMENT_RESOURCE,
    resourceType: "comment_resource",
    resourceId: id,
    before: { name: existing.name },
    ip: clientIp(req),
  });
  return ok({ deleted: true });
});
