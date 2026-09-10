import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx } from "@/lib/api";
import { requireOwner } from "@/lib/auth/guard";
import { hashPassword, checkPasswordPolicy } from "@/lib/auth/password";
import { notFound, validationError } from "@/lib/errors";
import { audit, AuditActions } from "@/lib/audit";
import { revokeAllSessionsForAdmin } from "@/lib/auth/session";

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.enum(["OWNER", "ADMIN"]).optional(),
  isActive: z.boolean().optional(),
  password: z.string().max(200).optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireOwner();
  const { id } = await ctx.params;
  const body = await parseBody(req, updateSchema);

  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target) throw notFound("Admin");

  // Safety: cannot demote/disable the last active OWNER (including yourself).
  if ((body.role === "ADMIN" || body.isActive === false) && target.role === "OWNER") {
    const owners = await prisma.admin.count({ where: { role: "OWNER", isActive: true, NOT: { id } } });
    if (owners === 0) throw validationError("Cannot demote or disable the last active OWNER");
  }

  const data: {
    name?: string;
    role?: "OWNER" | "ADMIN";
    isActive?: boolean;
    passwordHash?: string;
  } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.role !== undefined) data.role = body.role;
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.password) {
    const policy = checkPasswordPolicy(body.password);
    if (!policy.ok) throw validationError(`Password must contain: ${policy.problems.join(", ")}`);
    data.passwordHash = await hashPassword(body.password);
  }

  const updated = await prisma.admin.update({
    where: { id },
    data,
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });

  // Password change or deactivation kills existing sessions.
  if (data.passwordHash || body.isActive === false) await revokeAllSessionsForAdmin(id);

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPDATED_ADMIN,
    resourceType: "admin",
    resourceId: id,
    before: { role: target.role, isActive: target.isActive },
    after: { role: updated.role, isActive: updated.isActive, passwordChanged: Boolean(data.passwordHash) },
    ip: clientIp(req),
  });

  return ok({ admin: updated });
});
