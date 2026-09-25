import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { normalizeLogin, verifyPassword } from "@/lib/auth/password";
import { createSession, sessionCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";
import { route, parseBody, clientIp, assertSameOrigin, enforceRateLimit } from "@/lib/api";
import { AppError } from "@/lib/errors";
import { audit, AuditActions } from "@/lib/audit";
import { createLogger, errorFields } from "@/lib/logger";
import { LIMITS, LOGIN_LOCKOUT, loginLockout, resetRateLimit, type LoginFailures } from "@/lib/rate-limit";

const log = createLogger("auth.login");

/**
 * A real cost-12 bcrypt digest (of a random string nobody holds), compared
 * against when the login does not exist or is disabled.
 *
 * Without it `admin && admin.isActive && await verifyPassword(...)`
 * short-circuits, so an unknown login answers in about a millisecond while a
 * real one spends ~350 ms in bcrypt. The response bodies are deliberately
 * identical, but that timing gap announces which logins exist just as clearly
 * as a different message would, and it is measurable over the network.
 */
const ABSENT_ADMIN_PASSWORD_HASH = "$2a$12$G3Z98Da25BFs7XVBM1nwzej85qtfoLJONuLkIi9ZA5VNXth/HKeSe";

const loginSchema = z.object({
  login: z.string().min(1, "Login is required").max(64),
  password: z.string().min(1, "Password is required").max(200),
});

/**
 * Durable half of the brute-force guard. The in-process limiter above only
 * covers one server instance — on serverless an attacker simply lands on a
 * different lambda — so the real ceiling is counted from the LOGIN_FAILED audit
 * rows this route already writes. No new table: AuditLog is indexed on
 * (action, createdAt), which is exactly the lookup below.
 */
async function recentLoginFailures(login: string, ip: string): Promise<LoginFailures> {
  const since = new Date(Date.now() - LOGIN_LOCKOUT.windowMs);
  // "unknown" is every un-attributable caller at once; locking on it would be a
  // self-inflicted outage rather than a defence, so only the login scope applies.
  const byIp = ip !== "unknown";
  const rows = await prisma.auditLog.findMany({
    where: {
      // Successes are read alongside the failures: one of them settles this
      // login's count (see below).
      action: { in: [AuditActions.LOGIN_FAILED, AuditActions.LOGIN] },
      createdAt: { gte: since },
      ...(byIp ? { OR: [{ ip }, { after: { path: ["login"], equals: login } }] } : { after: { path: ["login"], equals: login } }),
    },
    select: { action: true, ip: true, after: true, createdAt: true },
    // Newest first, so that when `take` bites on a noisy installation it keeps
    // what just happened rather than what is about to expire — and so the row
    // that decides when the lock lifts (the threshold-th newest) is always in
    // hand, thresholds being far below the cap.
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const failures: LoginFailures = { forLogin: [], forIp: [] };
  // Rows arrive newest first, so once a successful sign-in for this login is
  // seen every remaining failure for it is OLDER than that success. Those were
  // settled by someone proving they hold the password, exactly as
  // resetRateLimit() settles the in-process bucket; counting them anyway locked
  // an admin out of their own account minutes after they signed into it.
  // The IP scope is deliberately NOT settled: one valid credential says nothing
  // about the other logins that address has been trying.
  let settled = false;
  for (const row of rows) {
    const rowLogin = (row.after as { login?: string } | null)?.login;
    if (row.action === AuditActions.LOGIN) {
      if (rowLogin === login) settled = true;
      continue;
    }
    if (!settled && rowLogin === login) failures.forLogin.push(row.createdAt);
    if (byIp && row.ip === ip) failures.forIp.push(row.createdAt);
  }
  return failures;
}

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const ip = clientIp(req);
  const body = await parseBody(req, loginSchema);
  const login = normalizeLogin(body.login);

  const loginKey = `login:${ip}:${login}`;
  enforceRateLimit(loginKey, LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs);
  // Same reasoning as the durable counter below: with no proxy header to go on,
  // `unknown` is every caller at once, so one shared bucket would cap the whole
  // installation at LOGIN_IP sign-ins rather than cap an attacker. The per-login
  // bucket above still applies, and it is the one that caps guessing a password.
  if (ip !== "unknown") {
    enforceRateLimit(`login-ip:${ip}`, LIMITS.LOGIN_IP.limit, LIMITS.LOGIN_IP.windowMs);
  }

  // Checked before the password is verified: a locked-out attacker must not get
  // free bcrypt work out of us, and must not learn whether the login exists.
  const lock = await recentLoginFailures(login, ip)
    .then((failures) => loginLockout(failures))
    .catch((err) => {
      // Availability wins over the extra guard: the in-process limiter is still
      // in force above, so a failed count degrades rather than bars sign-in.
      log.error("login lockout check failed", errorFields(err));
      return null;
    });

  if (lock?.locked) {
    await audit({
      action: "LOGIN_LOCKED",
      resourceType: "admin",
      ip,
      success: false,
      error: `locked by ${lock.scope} after repeated failures`,
      after: { scope: lock.scope },
    });
    throw new AppError("RATE_LIMITED", "Too many failed sign-in attempts", {
      reason:
        lock.scope === "login"
          ? `This login has failed ${LOGIN_LOCKOUT.perLogin} or more times in the last ${Math.round(LOGIN_LOCKOUT.windowMs / 60_000)} minutes.`
          : `This address has failed ${LOGIN_LOCKOUT.perIp} or more sign-ins in the last ${Math.round(LOGIN_LOCKOUT.windowMs / 60_000)} minutes.`,
      fix: `Wait ${Math.ceil(lock.retryAfterSec / 60)} minute(s) and try again.`,
    });
  }

  const admin = await prisma.admin.findUnique({ where: { login } });
  // Verified unconditionally — a missing account is compared against a stand-in
  // digest so every outcome costs the same bcrypt work (see the constant above).
  const passwordOk = await verifyPassword(body.password, admin?.passwordHash || ABSENT_ADMIN_PASSWORD_HASH);

  if (!admin || !admin.isActive || !passwordOk) {
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
      // Quote the ceiling this caller actually meets first: the in-process
      // limiter stops them at LOGIN.limit long before the durable lockout's
      // higher, installation-wide threshold is in reach.
      fix: `Check your credentials. Further attempts are refused after ${LIMITS.LOGIN.limit} failures from one address, and the login itself locks after ${LOGIN_LOCKOUT.perLogin} failures in ${Math.round(LOGIN_LOCKOUT.windowMs / 60_000)} minutes.`,
    });
  }

  // The right password clears this address's failure count for this login —
  // without it a legitimate admin signing in from a handful of devices inside
  // one window locks themselves out of their own account. Only the per-login
  // bucket is cleared: the IP-wide one caps spraying across OTHER logins, which
  // one correct password says nothing about.
  resetRateLimit(loginKey);

  const { token, session } = await createSession(admin.id, ip, req.headers.get("user-agent"));
  prisma.admin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } }).catch(() => undefined);
  // `after.login` is what lets the durable counter above recognise this success
  // as settling the failures recorded against the same login.
  await audit({ adminId: admin.id, action: AuditActions.LOGIN, ip, resourceType: "admin", resourceId: admin.id, after: { login } });

  const res = NextResponse.json({
    ok: true,
    data: { admin: { id: admin.id, login: admin.login, name: admin.name, role: admin.role } },
  });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions(session.expiresAt));
  return res;
});
