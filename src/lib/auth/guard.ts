import { redirect } from "next/navigation";
import { getAuth, type AuthContext } from "./session";
import { forbidden, unauthorized } from "@/lib/errors";

/** For server components / pages: redirect to /login when unauthenticated. */
export async function requireAuthPage(): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) redirect("/login");
  return auth;
}

/** For API routes: throw 401/403 AppErrors (mapped by src/lib/api.ts). */
export async function requireAdmin(): Promise<AuthContext> {
  const auth = await getAuth();
  if (!auth) throw unauthorized();
  return auth;
}

export async function requireOwner(): Promise<AuthContext> {
  const auth = await requireAdmin();
  if (auth.admin.role !== "OWNER") throw forbidden("Only the OWNER role can perform this action");
  return auth;
}
