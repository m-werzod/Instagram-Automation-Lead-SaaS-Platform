import { redirect } from "next/navigation";
import { getAuth, type AuthContext } from "./session";
import { forbidden, unauthorized } from "@/lib/errors";
import { isStaff } from "./access";

/** For server components / pages: redirect to /login when unauthenticated. */
export async function requireAuthPage(): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  return auth;
}

/**
 * For API routes: any signed-in account (OWNER, ADMIN or USER). Account-level
 * scoping is applied separately with src/lib/auth/access.ts — this only
 * establishes WHO is asking.
 */
export async function requireAdmin(): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) throw unauthorized();
  return auth;
}

/** OWNER or ADMIN — platform-wide operations (settings, users, audit, connections). */
export async function requireStaff(): Promise<AuthContext> {
  const auth = await requireAdmin();
  if (!isStaff(auth)) throw forbidden("This action is limited to administrators");
  return auth;
}

export async function requireOwner(): Promise<AuthContext> {
  const auth = await requireAdmin();
  if (auth.admin.role !== "OWNER") throw forbidden("Only the OWNER role can perform this action");
  return auth;
}
