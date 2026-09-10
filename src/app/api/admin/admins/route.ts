import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp } from "@/lib/api";
import { requireOwner, requireAdmin } from "@/lib/auth/guard";
import { hashPassword, checkPasswordPolicy } from "@/lib/auth/password";
import { validationError } from "@/lib/errors";
import { audit, AuditActions } from "@/lib/audit";

export const GET = route(async () => {
  await requireAdmin();
  const admins = await prisma.admin.findMany({
    select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  return ok({ admins });
});

const createSchema = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(120),
  password: z.string().max(200),
  role: z.enum(["OWNER", "ADMIN"]).default("ADMIN"),
});

/** Only OWNER can create admins — this platform has no public registration. */
export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireOwner();
  const body = await parseBody(req, createSchema);

  const policy = checkPasswordPolicy(body.password);
  if (!policy.ok) throw validationError(`Password must contain: ${policy.problems.join(", ")}`);

  const email = body.email.trim().toLowerCase();
  const existing = await prisma.admin.findUnique({ where: { email } });
  if (existing) throw validationError("An admin with this email already exists");

  const admin = await prisma.admin.create({
    data: { email, name: body.name, passwordHash: await hashPassword(body.password), role: body.role },
    select: { id: true, email: true, name: true, role: true, isActive: true },
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CREATED_ADMIN,
    resourceType: "admin",
    resourceId: admin.id,
    after: { email: admin.email, role: admin.role },
    ip: clientIp(req),
  });

  return ok({ admin });
});
