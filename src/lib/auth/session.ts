import { cookies } from "next/headers";
import type { Admin, Session } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashSessionToken, randomToken } from "@/lib/crypto";
import { coreEnv, isProd } from "@/lib/env";

export const SESSION_COOKIE = "ig_admin_session";
/** Absolute session lifetime. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
/** Idle timeout — session dies if unused this long. */
const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 h
/** Only bump lastSeenAt if older than this (write-avoidance). */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export interface AuthContext {
  admin: Pick<Admin, "id" | "email" | "name" | "role">;
  session: Pick<Session, "id" | "expiresAt">;
}

export async function createSession(adminId: string, ip?: string | null, userAgent?: string | null) {
  const token = randomToken(32);
  const session = await prisma.session.create({
    data: {
      adminId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      ip: ip ?? undefined,
      userAgent: userAgent?.slice(0, 300) ?? undefined,
    },
  });
  return { token, session };
}

export function sessionCookieOptions(expiresAt: Date) {
  return {
    httpOnly: true,
    secure: isProd() || coreEnv().APP_URL.startsWith("https"),
    sameSite: "lax" as const,
    path: "/",
    expires: expiresAt,
  };
}

/** Validate the request's session cookie. Returns null when not authenticated. */
export async function getAuth(): Promise<AuthContext | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { admin: { select: { id: true, email: true, name: true, role: true, isActive: true } } },
  });
  if (!session || session.revokedAt) return null;

  const now = Date.now();
  if (session.expiresAt.getTime() < now) return null;
  if (session.lastSeenAt.getTime() + IDLE_TIMEOUT_MS < now) return null;
  if (!session.admin.isActive) return null;

  if (session.lastSeenAt.getTime() + TOUCH_INTERVAL_MS < now) {
    // best-effort; never block the request on this write
    prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }

  return {
    admin: {
      id: session.admin.id,
      email: session.admin.email,
      name: session.admin.name,
      role: session.admin.role,
    },
    session: { id: session.id, expiresAt: session.expiresAt },
  };
}

export async function revokeSession(sessionId: string) {
  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } }).catch(() => undefined);
}

export async function revokeAllSessionsForAdmin(adminId: string) {
  await prisma.session.updateMany({ where: { adminId, revokedAt: null }, data: { revokedAt: new Date() } });
}
