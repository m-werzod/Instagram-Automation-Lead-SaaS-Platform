import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireOwner } from "@/lib/auth/guard";
import { hashPassword, checkPasswordPolicy, checkLoginFormat, normalizeLogin } from "@/lib/auth/password";
import { notFound, validationError } from "@/lib/errors";
import { audit, AuditActions } from "@/lib/audit";
import { revokeAllSessionsForAdmin } from "@/lib/auth/session";

const updateSchema = z.object({
  login: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().max(200).nullable().optional(),
  role: z.enum(["OWNER", "ADMIN"]).optional(),
  isActive: z.boolean().optional(),
  password: z.string().max(200).optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireOwner();
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, updateSchema);

  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target) throw notFound("Admin");

  // Safety: cannot demote/disable the last active OWNER (including yourself).
  if ((body.role === "ADMIN" || body.isActive === false) && target.role === "OWNER") {
    const owners = await prisma.admin.count({ where: { role: "OWNER", isActive: true, NOT: { id } } });
    if (owners === 0) throw validationError("Cannot demote or disable the last active OWNER");
  }

  const data: {
    login?: string;
    email?: string | null;
    name?: string;
    role?: "OWNER" | "ADMIN";
    isActive?: boolean;
    passwordHash?: string;
  } = {};
  if (body.login !== undefined) {
    const check = checkLoginFormat(body.login);
    if (!check.ok) throw validationError(`Login must be: ${check.problems.join(", ")}`);
    const login = normalizeLogin(body.login);
    const clash = await prisma.admin.findUnique({ where: { login } });
    if (clash && clash.id !== id) throw validationError("An admin with this login already exists");
    data.login = login;
  }
  if (body.email !== undefined) data.email = body.email ? body.email.trim().toLowerCase() : null;
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
    select: { id: true, login: true, email: true, name: true, role: true, isActive: true },
  });

  // Password change or deactivation kills existing sessions.
  if (data.passwordHash || body.isActive === false) await revokeAllSessionsForAdmin(id);

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPDATED_ADMIN,
    resourceType: "admin",
    resourceId: id,
    before: { login: target.login, role: target.role, isActive: target.isActive },
    after: {
      login: updated.login,
      role: updated.role,
      isActive: updated.isActive,
      passwordChanged: Boolean(data.passwordHash),
    },
    ip: clientIp(req),
  });

  return ok({ admin: updated });
});
