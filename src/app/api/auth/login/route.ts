import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { normalizeLogin, verifyPassword } from "@/lib/auth/password";
import { createSession, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";
import { route, parseBody, clientIp, assertSameOrigin, enforceRateLimit } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { audit, AuditActions } from "@/lib/audit";
import { LIMITS } from "@/lib/rate-limit";

const loginSchema = z.object({
  login: z.string().min(1, "Login is required").max(64),
  password: z.string().min(1, "Password is required").max(200),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const ip = clientIp(req);
  const body = await parseBody(req, loginSchema);
  const login = normalizeLogin(body.login);

  enforceRateLimit(`login:${ip}:${login}`, LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs);

  const admin = await prisma.admin.findUnique({ where: { login } });
  const valid = admin && admin.isActive && (await verifyPassword(body.password, admin.passwordHash));

  if (!valid) {
    await audit({
      action: AuditActions.LOGIN_FAILED,
      resourceType: "admin",
      resourceId: admin?.id,
      ip,
      success: false,
      error: admin ? (admin.isActive ? "bad password" : "account disabled") : "unknown login",
      after: { login },
    });
    // identical response for unknown login / bad password / disabled account
    throw new AppError("UNAUTHORIZED", "Incorrect login or password", {
      fix: "Check your credentials. Sign-in locks for 5 minutes after 5 failed attempts.",
    });
  }

  const { token, session } = await createSession(admin.id, ip, req.headers.get("user-agent"));
  await audit({ adminId: admin.id, action: AuditActions.LOGIN, ip });

  const res = NextResponse.json({
    ok: true,
    data: { admin: { id: admin.id, login: admin.login, name: admin.name, role: admin.role } },
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(session.expiresAt));
  return res;
});
