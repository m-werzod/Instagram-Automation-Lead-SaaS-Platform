import { NextRequest } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, enforceRateLimit, type RouteCtx, pathParam } from "@/lib/api";
import { requireStaff } from "@/lib/auth/guard";
import { hashPassword, checkPasswordPolicy, checkLoginFormat, normalizeLogin } from "@/lib/auth/password";
import { forbidden, notFound, validationError } from "@/lib/errors";
import { audit, AuditActions } from "@/lib/audit";
import { revokeAllSessionsForAdmin } from "@/lib/auth/session";
import { wouldLeaveUserWithoutAccounts } from "@/lib/auth/access";
import { LIMITS } from "@/lib/rate-limit";
import { isUniqueConstraintError } from "@/lib/prisma-errors";

/**
 * One user: detail (what they hold, what they did), update (role, active,
 * password, granted accounts) and removal. Managing an OWNER/ADMIN record —
 * or promoting anyone to one — is reserved for the OWNER.
 */

function managesStaffRecord(target: { role: string }, body?: { role?: string }): boolean {
  return target.role !== "USER" || (body?.role !== undefined && body.role !== "USER");
}

export const GET = route(async (_req, ctx: RouteCtx) => {
  await requireStaff();
  const id = await pathParam(ctx, "id");
  const admin = await prisma.admin.findUnique({
    where: { id },
    select: {
      id: true,
      login: true,
      email: true,
      name: true,
      role: true,
      isActive: true,
      lastLoginAt: true,
      createdAt: true,
      accountAccess: {
        select: {
          createdAt: true,
          account: { select: { id: true, username: true, status: true, isDemo: true, adAccountId: true } },
        },
      },
    },
  });
  if (!admin) throw notFound("User");

  // What this person can reach: everything for staff, the granted set for a USER.
  const staff = admin.role !== "USER";
  const accountIds = admin.accountAccess.map((g) => g.account.id);
  const scope = staff ? {} : { accountId: { in: accountIds } };

  const [leads, qualified, campaigns, activeCampaigns, agents, activeSessions, recentActivity] = await Promise.all([
    prisma.lead.count({ where: scope }),
    prisma.lead.count({ where: { ...scope, status: { in: ["QUALIFIED", "IN_PROGRESS", "WON"] } } }),
    prisma.campaign.count({ where: scope }),
    prisma.campaign.count({ where: { ...scope, status: "ACTIVE" } }),
    prisma.aIAgent.count({ where: { ...scope, enabled: true } }),
    prisma.session.count({ where: { adminId: id, revokedAt: null, expiresAt: { gt: new Date() } } }),
    prisma.auditLog.findMany({
      where: { adminId: id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, action: true, resourceType: true, success: true, error: true, createdAt: true },
    }),
  ]);

  const { accountAccess, ...safe } = admin;
  return ok({
    admin: safe,
    accounts: accountAccess.map((g) => ({ ...g.account, grantedAt: g.createdAt })),
    stats: { leads, qualified, campaigns, activeCampaigns, agents, activeSessions },
    recentActivity,
  });
});

const updateSchema = z.object({
  login: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().max(200).nullable().optional(),
  role: z.enum(["OWNER", "ADMIN", "USER"]).optional(),
  isActive: z.boolean().optional(),
  password: z.string().max(200).optional(),
  /** Full replacement of the granted Instagram accounts (USER role only). */
  accountIds: z.array(z.string().min(1)).max(100).optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireStaff();
  enforceRateLimit(`admin-write:${auth.admin.id}`, LIMITS.ADMIN_WRITE.limit, LIMITS.ADMIN_WRITE.windowMs);
  const id = await pathParam(ctx, "id");
  const body = await parseBody(req, updateSchema);

  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target) throw notFound("User");

  if (auth.admin.role !== "OWNER" && managesStaffRecord(target, body)) {
    throw forbidden("Only the OWNER can change administrator accounts");
  }
  if (id === auth.admin.id && (body.role !== undefined || body.isActive === false)) {
    throw validationError("You cannot change your own role or suspend yourself");
  }

  // Safety: cannot demote/suspend the last active OWNER.
  const demotesOwner = (body.role !== undefined && body.role !== "OWNER") || body.isActive === false;
  if (demotesOwner && target.role === "OWNER") {
    const owners = await prisma.admin.count({ where: { role: "OWNER", isActive: true, NOT: { id } } });
    if (owners === 0) throw validationError("Cannot demote or suspend the last active OWNER");
  }

  const data: {
    login?: string;
    email?: string | null;
    name?: string;
    role?: "OWNER" | "ADMIN" | "USER";
    isActive?: boolean;
    passwordHash?: string;
  } = {};
  if (body.login !== undefined) {
    const check = checkLoginFormat(body.login);
    if (!check.ok) throw validationError(`Login must be: ${check.problems.join(", ")}`);
    const login = normalizeLogin(body.login);
    const clash = await prisma.admin.findUnique({ where: { login } });
    if (clash && clash.id !== id) throw validationError("A user with this login already exists");
    data.login = login;
  }
  if (body.email !== undefined) {
    const email = body.email ? body.email.trim().toLowerCase() : null;
    if (email) {
      const clash = await prisma.admin.findUnique({ where: { email } });
      if (clash && clash.id !== id) throw validationError("A user with this email already exists");
    }
    data.email = email;
  }
  if (body.name !== undefined) data.name = body.name;
  if (body.role !== undefined) data.role = body.role;
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.password) {
    const policy = checkPasswordPolicy(body.password);
    if (!policy.ok) throw validationError(`Password must contain: ${policy.problems.join(", ")}`);
    data.passwordHash = await hashPassword(body.password);
  }

  const finalRole = body.role ?? target.role;

  // A USER with zero granted accounts signs in to a completely empty platform —
  // refuse rather than silently produce one.
  if (
    wouldLeaveUserWithoutAccounts({
      finalRole,
      roleIsChanging: body.role !== undefined,
      providedAccountIds: body.accountIds,
      existingGrantCount:
        body.accountIds === undefined && body.role !== undefined
          ? await prisma.accountAccess.count({ where: { adminId: id } })
          : 0,
    })
  ) {
    throw validationError("A USER must have at least one Instagram account assigned");
  }

  let grantedAccounts: number | undefined;
  const accountOps: Prisma.PrismaPromise<unknown>[] = [];
  if (body.accountIds !== undefined || (body.role !== undefined && body.role !== "USER")) {
    // Staff are unrestricted, so a promotion clears the (now meaningless) grants.
    const accountIds = finalRole === "USER" ? [...new Set(body.accountIds ?? [])] : [];
    if (accountIds.length > 0) {
      const found = await prisma.instagramAccount.count({ where: { id: { in: accountIds } } });
      if (found !== accountIds.length) throw validationError("One of the selected Instagram accounts does not exist");
    }
    accountOps.push(
      prisma.accountAccess.deleteMany({
        where: { adminId: id, ...(accountIds.length ? { accountId: { notIn: accountIds } } : {}) },
      }),
      ...accountIds.map((accountId) =>
        prisma.accountAccess.upsert({
          where: { adminId_accountId: { adminId: id, accountId } },
          create: { adminId: id, accountId, grantedById: auth.admin.id },
          update: {},
        }),
      ),
    );
    grantedAccounts = accountIds.length;
  }

  // One transaction for the account-access change AND the admin row itself, so a
  // failure on either side (e.g. a last-second unique-constraint race) can never
  // leave one half committed while the other silently didn't happen.
  let updated;
  try {
    const results = await prisma.$transaction([
      ...accountOps,
      prisma.admin.update({
        where: { id },
        data,
        select: { id: true, login: true, email: true, name: true, role: true, isActive: true, lastLoginAt: true },
      }),
    ]);
    updated = results[results.length - 1] as {
      id: string;
      login: string;
      email: string | null;
      name: string;
      role: "OWNER" | "ADMIN" | "USER";
      isActive: boolean;
      lastLoginAt: Date | null;
    };
  } catch (err) {
    if (isUniqueConstraintError(err)) throw validationError("A user with this login or email already exists");
    throw err;
  }

  // Password change, suspension or a role change kills existing sessions.
  if (data.passwordHash || body.isActive === false || (body.role !== undefined && body.role !== target.role)) {
    await revokeAllSessionsForAdmin(id);
  }

  await audit({
    adminId: auth.admin.id,
    action:
      body.isActive === false
        ? AuditActions.SUSPENDED_USER
        : body.isActive === true && !target.isActive
          ? AuditActions.REACTIVATED_USER
          : grantedAccounts !== undefined && Object.keys(data).length === 0
            ? AuditActions.GRANTED_ACCOUNT_ACCESS
            : AuditActions.UPDATED_ADMIN,
    resourceType: "admin",
    resourceId: id,
    before: { login: target.login, role: target.role, isActive: target.isActive },
    after: {
      login: updated.login,
      role: updated.role,
      isActive: updated.isActive,
      passwordChanged: Boolean(data.passwordHash),
      ...(grantedAccounts !== undefined ? { grantedAccounts } : {}),
    },
    ip: clientIp(req),
  });

  return ok({ admin: updated });
});

export const DELETE = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireStaff();
  // Same ceiling as creating and editing: removing accounts is the most
  // destructive of the three, so it must not be the only one left on the
  // blanket 120/min API_WRITE floor.
  enforceRateLimit(`admin-write:${auth.admin.id}`, LIMITS.ADMIN_WRITE.limit, LIMITS.ADMIN_WRITE.windowMs);
  const id = await pathParam(ctx, "id");
  const target = await prisma.admin.findUnique({ where: { id } });
  if (!target) throw notFound("User");
  if (id === auth.admin.id) throw validationError("You cannot remove your own account");
  if (auth.admin.role !== "OWNER" && managesStaffRecord(target)) {
    throw forbidden("Only the OWNER can remove administrator accounts");
  }
  if (target.role === "OWNER") {
    const owners = await prisma.admin.count({ where: { role: "OWNER", isActive: true, NOT: { id } } });
    if (owners === 0) throw validationError("Cannot remove the last active OWNER");
  }

  // Sessions and grants cascade; audit rows keep their history with adminId set to null.
  await prisma.admin.delete({ where: { id } });
  await audit({
    adminId: auth.admin.id,
    action: AuditActions.REMOVED_USER,
    resourceType: "admin",
    resourceId: id,
    before: { login: target.login, role: target.role },
    ip: clientIp(req),
  });
  return ok({ deleted: true });
});
