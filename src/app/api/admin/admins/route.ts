import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, enforceRateLimit } from "@/lib/api";
import { requireStaff } from "@/lib/auth/guard";
import { hashPassword, checkPasswordPolicy, checkLoginFormat, normalizeLogin } from "@/lib/auth/password";
import { forbidden, validationError } from "@/lib/errors";
import { audit, AuditActions } from "@/lib/audit";
import { wouldLeaveUserWithoutAccounts } from "@/lib/auth/access";
import { LIMITS } from "@/lib/rate-limit";
import { isUniqueConstraintError } from "@/lib/prisma-errors";

/**
 * Users of the platform. Three roles:
 *   OWNER — everything, including creating other OWNER/ADMIN accounts
 *   ADMIN — everything except managing OWNER/ADMIN accounts
 *   USER  — only the Instagram accounts granted to them (AccountAccess)
 */

export const GET = route(async () => {
  await requireStaff();
  const admins = await prisma.admin.findMany({
    select: {
      id: true,
      login: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
      accountAccess: { select: { account: { select: { id: true, username: true, status: true } } } },
    },
    orderBy: { createdAt: "asc" },
  });
  return ok({
    admins: admins.map(({ accountAccess, ...a }) => ({ ...a, accounts: accountAccess.map((g) => g.account) })),
  });
});

const createSchema = z.object({
  login: z.string().min(1).max(64),
  email: z.string().email().max(200).optional().or(z.literal("")),
  name: z.string().min(1).max(120),
  password: z.string().max(200),
  role: z.enum(["OWNER", "ADMIN", "USER"]).default("USER"),
  /** Instagram accounts a USER may see. Ignored for OWNER/ADMIN (unrestricted). */
  accountIds: z.array(z.string().min(1)).max(100).default([]),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireStaff();
  enforceRateLimit(`admin-write:${auth.admin.id}`, LIMITS.ADMIN_WRITE.limit, LIMITS.ADMIN_WRITE.windowMs);
  const body = await parseBody(req, createSchema);

  // Only an OWNER may mint another administrator; an ADMIN onboards USERs.
  if (body.role !== "USER" && auth.admin.role !== "OWNER") {
    throw forbidden("Only the OWNER can create administrator accounts");
  }
  if (wouldLeaveUserWithoutAccounts({ finalRole: body.role, roleIsChanging: true, providedAccountIds: body.accountIds, existingGrantCount: 0 })) {
    throw validationError("A USER must have at least one Instagram account assigned");
  }

  const loginCheck = checkLoginFormat(body.login);
  if (!loginCheck.ok) throw validationError(`Login must be: ${loginCheck.problems.join(", ")}`);

  const policy = checkPasswordPolicy(body.password);
  if (!policy.ok) throw validationError(`Password must contain: ${policy.problems.join(", ")}`);

  const login = normalizeLogin(body.login);
  const email = body.email ? body.email.trim().toLowerCase() : null;

  if (await prisma.admin.findUnique({ where: { login } })) {
    throw validationError("A user with this login already exists");
  }
  if (email && (await prisma.admin.findUnique({ where: { email } }))) {
    throw validationError("A user with this email already exists");
  }

  const accountIds = body.role === "USER" ? [...new Set(body.accountIds)] : [];
  if (accountIds.length > 0) {
    const found = await prisma.instagramAccount.count({ where: { id: { in: accountIds } } });
    if (found !== accountIds.length) throw validationError("One of the selected Instagram accounts does not exist");
  }

  let admin;
  try {
    admin = await prisma.admin.create({
      data: {
        login,
        email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        role: body.role,
        accountAccess: { create: accountIds.map((accountId) => ({ accountId, grantedById: auth.admin.id })) },
      },
      select: { id: true, login: true, email: true, name: true, role: true, isActive: true },
    });
  } catch (err) {
    // Race with a concurrent create using the same login/email — the pre-checks
    // above already cover the common case; this closes the narrow gap between them.
    if (isUniqueConstraintError(err)) throw validationError("A user with this login or email already exists");
    throw err;
  }

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CREATED_ADMIN,
    resourceType: "admin",
    resourceId: admin.id,
    after: { login: admin.login, role: admin.role, accounts: accountIds.length },
    ip: clientIp(req),
  });

  return ok({ admin });
});
