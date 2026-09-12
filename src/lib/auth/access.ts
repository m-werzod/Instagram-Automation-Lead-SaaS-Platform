import { prisma } from "@/lib/prisma";
import { forbidden } from "@/lib/errors";
import type { AuthContext } from "./session";

/**
 * Account-level authorization.
 *
 * OWNER and ADMIN see and operate every Instagram account. A USER sees only the
 * accounts listed for them in AccountAccess. Enforced here, server-side, on
 * every account-scoped route — never by hiding things in the UI alone.
 *
 * Two shapes cover every route:
 *   accountScope(auth, requestedId)  → Prisma `where` fragment for LIST queries
 *   assertAccountAccess(auth, id)    → 403 guard for ONE account / resource
 */

export type Role = AuthContext["admin"]["role"];

export function isStaff(auth: Pick<AuthContext, "admin">): boolean {
  return auth.admin.role === "OWNER" || auth.admin.role === "ADMIN";
}

export type AccountFilter =
  | { kind: "all" }
  | { kind: "one"; id: string }
  | { kind: "many"; ids: string[] }
  | { kind: "forbidden"; id: string };

/**
 * Pure decision (unit-tested): given the role, the accounts granted to a USER,
 * and the account the request asked for (if any), what may the query see?
 */
export function resolveAccountFilter(role: Role, grantedIds: string[], requestedId?: string | null): AccountFilter {
  const staff = role === "OWNER" || role === "ADMIN";
  if (requestedId) {
    if (staff || grantedIds.includes(requestedId)) return { kind: "one", id: requestedId };
    return { kind: "forbidden", id: requestedId };
  }
  if (staff) return { kind: "all" };
  return { kind: "many", ids: grantedIds };
}

export type AccountWhere = { accountId?: string | { in: string[] } };

export function whereFromFilter(filter: AccountFilter): AccountWhere {
  switch (filter.kind) {
    case "all":
      return {};
    case "one":
      return { accountId: filter.id };
    case "many":
      return { accountId: { in: filter.ids } };
    case "forbidden":
      throw noAccess();
  }
}

function noAccess() {
  return forbidden("You do not have access to this Instagram account");
}

export async function grantedAccountIds(adminId: string): Promise<string[]> {
  const rows = await prisma.accountAccess.findMany({ where: { adminId }, select: { accountId: true } });
  return rows.map((r) => r.accountId);
}

/** Prisma `where` fragment for account-scoped list queries. Throws 403 when a USER asks for an account they do not hold. */
export async function accountScope(auth: AuthContext, requestedId?: string | null): Promise<AccountWhere> {
  const ids = isStaff(auth) ? [] : await grantedAccountIds(auth.admin.id);
  return whereFromFilter(resolveAccountFilter(auth.admin.role, ids, requestedId));
}

/** Same scope, but for queries on InstagramAccount itself (filter by `id`). */
export async function accountIdScope(auth: AuthContext): Promise<{ id?: string | { in: string[] } }> {
  const scope = await accountScope(auth);
  return scope.accountId === undefined ? {} : { id: scope.accountId };
}

/** Throw 403 unless this admin may operate on the account. */
export async function assertAccountAccess(auth: AuthContext, accountId: string): Promise<void> {
  if (isStaff(auth)) return;
  const ids = await grantedAccountIds(auth.admin.id);
  if (!ids.includes(accountId)) throw noAccess();
}

/** Idempotent grant — used when a USER connects an account themselves, and by the users screen. */
export async function grantAccountAccess(adminId: string, accountId: string, grantedById?: string | null): Promise<void> {
  await prisma.accountAccess.upsert({
    where: { adminId_accountId: { adminId, accountId } },
    create: { adminId, accountId, grantedById: grantedById ?? null },
    update: {},
  });
}
