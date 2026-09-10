import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { verifyPassword } from "@/lib/auth/password";
import { createSession, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";
import { route, parseBody, clientIp, assertSameOrigin, enforceRateLimit } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { audit, AuditActions } from "@/lib/audit";
import { LIMITS } from "@/lib/rate-limit";

const loginSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const ip = clientIp(req);
  const body = await parseBody(req, loginSchema);
  const email = body.email.trim().toLowerCase();

  enforceRateLimit(`login:${ip}:${email}`, LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs);

  const admin = await prisma.admin.findUnique({ where: { email } });
  const valid = admin && admin.isActive && (await verifyPassword(body.password, admin.passwordHash));

  if (!valid) {
    await audit({
      action: AuditActions.LOGIN_FAILED,
      resourceType: "admin",
      resourceId: admin?.id,
      ip,
      success: false,
      error: admin ? (admin.isActive ? "bad password" : "account disabled") : "unknown email",
    });
    // identical response for unknown email / bad password / disabled account
    throw new AppError("UNAUTHORIZED", "Invalid email or password", {
      fix: "Check your credentials. Accounts lock for 5 minutes after 5 failed attempts.",
    });
  }

  const { token, session } = await createSession(admin.id, ip, req.headers.get("user-agent"));
  await audit({ adminId: admin.id, action: AuditActions.LOGIN, ip });

  const res = NextResponse.json({
    ok: true,
    data: { admin: { id: admin.id, email: admin.email, name: admin.name, role: admin.role } },
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(session.expiresAt));
  return res;
});
