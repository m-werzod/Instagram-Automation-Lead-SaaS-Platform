import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * QA sweep: authentication, sessions, RBAC and request security.
 *
 * Everything here runs the REAL product code. Prisma is replaced by an
 * in-memory stand-in for the four tables this area touches (Admin, Session,
 * AccountAccess, AuditLog) so session lifecycle, the durable login lockout and
 * account scoping are exercised end to end — including through the actual
 * /api/auth/* route handlers — without a database. bcrypt, AES-GCM and SHA-256
 * are never mocked: those run for real.
 */

const { store, prismaMock, cookieJar } = vi.hoisted(() => {
  type Row = Record<string, unknown>;

  const store = {
    admins: [] as Row[],
    sessions: [] as Row[],
    accountAccess: [] as Row[],
    auditLogs: [] as Row[],
    seq: 0,
    /** every table call, so a test can prove a code path never touched the database */
    calls: [] as string[],
    /** makes the next auditLog.findMany reject — the degraded-lockout path */
    failNextAuditFind: false,
  };

  const OPS = new Set(["in", "notIn", "gte", "gt", "lte", "lt", "not", "equals", "path", "contains"]);
  const isOperatorObject = (v: unknown): boolean =>
    typeof v === "object" && v !== null && !(v instanceof Date) && !Array.isArray(v) && Object.keys(v as Row).some((k) => OPS.has(k));

  const sameValue = (a: unknown, b: unknown): boolean => {
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    return a === b;
  };
  const time = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(String(v)).getTime());

  const matchCond = (value: unknown, cond: unknown): boolean => {
    if (cond === null) return value === null || value === undefined;
    if (cond instanceof Date || typeof cond !== "object") return sameValue(value, cond);
    const c = cond as Row;
    if ("path" in c && "equals" in c) {
      let cur: unknown = value;
      for (const seg of c.path as string[]) cur = cur === null || cur === undefined ? undefined : (cur as Row)[seg];
      return sameValue(cur, c.equals);
    }
    if ("in" in c) return (c.in as unknown[]).some((v) => sameValue(value, v));
    if ("notIn" in c) return !(c.notIn as unknown[]).some((v) => sameValue(value, v));
    if ("gte" in c) return value !== null && value !== undefined && time(value) >= time(c.gte);
    if ("gt" in c) return value !== null && value !== undefined && time(value) > time(c.gt);
    if ("lte" in c) return value !== null && value !== undefined && time(value) <= time(c.lte);
    if ("lt" in c) return value !== null && value !== undefined && time(value) < time(c.lt);
    if ("not" in c) return !matchCond(value, c.not);
    if ("equals" in c) return sameValue(value, c.equals);
    // An operator the stand-in does not implement must fail loudly, never match by accident.
    throw new Error(`unsupported prisma filter: ${JSON.stringify(cond)}`);
  };

  const matches = (row: Row, where?: Row): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([key, cond]) => {
      if (cond === undefined) return true;
      if (key === "OR") return (cond as Row[]).some((sub) => matches(row, sub));
      if (key === "AND") return (cond as Row[]).every((sub) => matches(row, sub));
      if (key === "NOT") return !matches(row, cond as Row);
      return matchCond(row[key], cond);
    });
  };

  /** `{ adminId_accountId: { adminId, accountId } }` → `{ adminId, accountId }` */
  const flatten = (where?: Row): Row | undefined => {
    if (!where) return where;
    const out: Row = {};
    for (const [k, v] of Object.entries(where)) {
      if (k.includes("_") && v !== null && typeof v === "object" && !(v instanceof Date) && !isOperatorObject(v)) {
        Object.assign(out, v as Row);
      } else {
        out[k] = v;
      }
    }
    return out;
  };

  interface TableOpts {
    defaults?: () => Row;
    hydrate?: (row: Row, args: Row) => Row;
  }

  const table = (name: string, rows: Row[], opts: TableOpts = {}) => {
    const shape = (row: Row, args: Row): Row => {
      const hydrated = opts.hydrate ? opts.hydrate({ ...row }, args) : { ...row };
      const select = args.select as Row | undefined;
      if (!select) return hydrated;
      const out: Row = {};
      for (const [k, v] of Object.entries(select)) if (v) out[k] = hydrated[k];
      return out;
    };

    const list = (args: Row): Row[] => {
      let found = rows.filter((r) => matches(r, flatten(args.where as Row | undefined)));
      const order = args.orderBy as Row | undefined;
      const first = order ? Object.entries(order)[0] : undefined;
      if (first) {
        const [field, dir] = first;
        found = [...found].sort((a, b) => {
          const av = a[field];
          const bv = b[field];
          const cmp = av instanceof Date && bv instanceof Date ? av.getTime() - bv.getTime() : String(av).localeCompare(String(bv));
          return dir === "desc" ? -cmp : cmp;
        });
      }
      const take = args.take as number | undefined;
      return take === undefined ? found : found.slice(0, take);
    };

    return {
      create: async (args: { data: Row }) => {
        store.calls.push(`${name}.create`);
        const row: Row = { id: `${name}_${++store.seq}`, createdAt: new Date(), ...(opts.defaults?.() ?? {}), ...args.data };
        rows.push(row);
        return shape(row, args as unknown as Row);
      },
      findUnique: async (args: Row) => {
        store.calls.push(`${name}.findUnique`);
        const row = rows.find((r) => matches(r, flatten(args.where as Row | undefined)));
        return row ? shape(row, args) : null;
      },
      findFirst: async (args: Row = {}) => {
        store.calls.push(`${name}.findFirst`);
        const row = list(args)[0];
        return row ? shape(row, args) : null;
      },
      findMany: async (args: Row = {}) => {
        store.calls.push(`${name}.findMany`);
        return list(args).map((r) => shape(r, args));
      },
      count: async (args: Row = {}) => {
        store.calls.push(`${name}.count`);
        return list(args).length;
      },
      update: async (args: { where: Row; data: Row }) => {
        store.calls.push(`${name}.update`);
        const row = rows.find((r) => matches(r, flatten(args.where)));
        if (!row) throw Object.assign(new Error("record not found"), { code: "P2025" });
        Object.assign(row, args.data, { updatedAt: new Date() });
        return { ...row };
      },
      updateMany: async (args: { where?: Row; data: Row }) => {
        store.calls.push(`${name}.updateMany`);
        const hit = rows.filter((r) => matches(r, flatten(args.where)));
        for (const row of hit) Object.assign(row, args.data, { updatedAt: new Date() });
        return { count: hit.length };
      },
      upsert: async (args: { where: Row; create: Row; update: Row }) => {
        store.calls.push(`${name}.upsert`);
        const row = rows.find((r) => matches(r, flatten(args.where)));
        if (row) {
          Object.assign(row, args.update, { updatedAt: new Date() });
          return { ...row };
        }
        const created: Row = { id: `${name}_${++store.seq}`, createdAt: new Date(), ...args.create };
        rows.push(created);
        return { ...created };
      },
      delete: async (args: { where: Row }) => {
        store.calls.push(`${name}.delete`);
        const i = rows.findIndex((r) => matches(r, flatten(args.where)));
        if (i === -1) throw Object.assign(new Error("record not found"), { code: "P2025" });
        return rows.splice(i, 1)[0];
      },
      deleteMany: async (args: { where?: Row } = {}) => {
        store.calls.push(`${name}.deleteMany`);
        const keep = rows.filter((r) => !matches(r, flatten(args.where)));
        const removed = rows.length - keep.length;
        rows.splice(0, rows.length, ...keep);
        return { count: removed };
      },
    };
  };

  const auditTable = table("auditLog", store.auditLogs, { defaults: () => ({ success: true, ip: null, after: null, adminId: null }) });

  const prismaMock = {
    admin: table("admin", store.admins, { defaults: () => ({ isActive: true, role: "ADMIN", lastLoginAt: null }) }),
    session: table("session", store.sessions, {
      defaults: () => ({ lastSeenAt: new Date(), revokedAt: null }),
      hydrate: (row, args) => {
        const include = args.include as Row | undefined;
        const spec = include?.admin as Row | undefined;
        if (!spec) return row;
        const admin = store.admins.find((a) => a.id === row.adminId);
        if (!admin) {
          row.admin = null;
          return row;
        }
        const select = spec.select as Row | undefined;
        if (!select) {
          row.admin = { ...admin };
          return row;
        }
        const picked: Row = {};
        for (const [k, v] of Object.entries(select)) if (v) picked[k] = admin[k];
        row.admin = picked;
        return row;
      },
    }),
    accountAccess: table("accountAccess", store.accountAccess),
    auditLog: {
      ...auditTable,
      findMany: async (args: Row = {}) => {
        if (store.failNextAuditFind) {
          store.failNextAuditFind = false;
          throw Object.assign(new Error("Can't reach database server"), { code: "P1001" });
        }
        return auditTable.findMany(args);
      },
    },
  };

  const cookieJar = {
    value: null as string | null,
    get(name: string) {
      return name === "ig_admin_session" && cookieJar.value !== null ? { name, value: cookieJar.value } : undefined;
    },
  };

  return { store, prismaMock, cookieJar };
});

vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));
vi.mock("next/headers", () => ({ cookies: async () => cookieJar }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error(`NEXT_REDIRECT ${url}`), { digest: `NEXT_REDIRECT;replace;${url}` });
  },
}));

import { checkLoginFormat, checkPasswordPolicy, hashPassword, MIN_PASSWORD_LENGTH, normalizeLogin, verifyPassword } from "@/lib/auth/password";
import {
  createSession,
  getAuth,
  revokeAllSessionsForAdmin,
  revokeSession,
  sessionCookieOptions,
  type AuthContext,
} from "@/lib/auth/session";
import { requireAdmin, requireAuthPage, requireOwner, requireStaff } from "@/lib/auth/guard";
import {
  accountIdScope,
  accountScope,
  assertAccountAccess,
  grantAccountAccess,
  grantedAccountIds,
  isStaff,
  resolveAccountFilter,
  whereFromFilter,
  wouldLeaveUserWithoutAccounts,
} from "@/lib/auth/access";
import { assertSameOrigin, clientIp, enforceRateLimit, isLocalHostname, ok, route, trustedHosts } from "@/lib/api";
import {
  LIMITS,
  LOGIN_LOCKOUT,
  loginLockout,
  rateLimit,
  rateLimiterInfo,
  resetRateLimit,
  _resetRateLimiter,
} from "@/lib/rate-limit";
import { decryptSecret, encryptSecret, hashSessionToken, randomToken, safeEqual, sha256Hex } from "@/lib/crypto";
import { isPublicPath, middleware } from "@/middleware";
import { _resetCoreEnvCache } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logoutRoute } from "@/app/api/auth/logout/route";
import { GET as meRoute } from "@/app/api/auth/me/route";

/**
 * bcrypt at cost 12 is deliberately slow (~250 ms a call) and several tests here
 * drive a dozen real sign-in attempts through the route, so the default 5 s
 * budget is a load-dependent coin flip. Nothing is skipped or weakened — the
 * work simply gets the time it honestly needs.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Row = Record<string, unknown>;
type Role = "OWNER" | "ADMIN" | "USER";

const DAY = 24 * 60 * 60 * 1000;
const ROUTE_CTX = { params: Promise.resolve({} as Record<string, string>) };

/** process.env.NODE_ENV is typed read-only; these tests flip it deliberately. */
function setNodeEnv(value: string) {
  (process.env as unknown as Record<string, string>).NODE_ENV = value;
  _resetCoreEnvCache();
}

function seedAdmin(patch: Row = {}): Row {
  const admin: Row = {
    id: `adm_${store.admins.length + 1}`,
    login: `admin${store.admins.length + 1}`,
    email: null,
    name: "Test Admin",
    passwordHash: "$2a$12$notarealhashnotarealhashnotarealhashnotarealhashnotar",
    role: "ADMIN",
    isActive: true,
    lastLoginAt: null,
    createdAt: new Date(),
  };
  Object.assign(admin, patch);
  store.admins.push(admin);
  return admin;
}

/** Real session creation (real random token, real peppered hash), then the row is aged as the test needs. */
async function signIn(adminId: string, patch: Row = {}): Promise<{ token: string; row: Row }> {
  const { token, session } = await createSession(adminId, "203.0.113.7", "vitest");
  const row = store.sessions.find((s) => s.id === (session as { id: string }).id);
  if (!row) throw new Error("session row missing");
  Object.assign(row, patch);
  cookieJar.value = token;
  return { token, row };
}

function auditRow(patch: Row): Row {
  const row: Row = {
    id: `al_${store.auditLogs.length + 1}`,
    action: "LOGIN_FAILED",
    adminId: null,
    resourceType: "admin",
    ip: null,
    success: false,
    after: null,
    createdAt: new Date(),
  };
  Object.assign(row, patch);
  store.auditLogs.push(row);
  return row;
}

function loginRequest(body: unknown, opts: { ip?: string | null; origin?: string | null; ua?: string } = {}) {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.origin !== null) headers.set("origin", opts.origin ?? "http://localhost:3000");
  if (opts.ip) headers.set("x-forwarded-for", opts.ip);
  if (opts.ua) headers.set("user-agent", opts.ua);
  return new NextRequest("http://localhost:3000/api/auth/login", { method: "POST", headers, body: JSON.stringify(body) });
}

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; reason?: string; fix?: string };
}

async function envelope(res: Response): Promise<Envelope> {
  return (await res.json()) as Envelope;
}

/** Drive one sign-in attempt through the real route, with the in-process limiter cleared first. */
async function attemptLogin(login: string, password: string, ip: string | null = "198.51.100.10") {
  _resetRateLimiter();
  return loginRoute(loginRequest({ login, password }, { ip }), ROUTE_CTX);
}

function tokenFromSetCookie(res: Response): string | null {
  const header = res.headers.get("set-cookie");
  if (!header) return null;
  const m = /ig_admin_session=([^;]*)/.exec(header);
  return m?.[1] ?? null;
}

/** Let a deliberately un-awaited "best effort" write (lastSeenAt touch, lastLoginAt) land. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  store.admins.length = 0;
  store.sessions.length = 0;
  store.accountAccess.length = 0;
  store.auditLogs.length = 0;
  store.calls.length = 0;
  store.seq = 0;
  store.failNextAuditFind = false;
  cookieJar.value = null;
  _resetRateLimiter();
});

afterEach(() => {
  delete process.env.TRUSTED_ORIGINS;
  delete process.env.TRUSTED_IP_HEADER;
  delete process.env.TRUSTED_PROXY_HOPS;
  delete process.env.VERCEL;
  vi.useRealTimers();
  setNodeEnv("test");
});

// ---------------------------------------------------------------------------
// 1. Passwords
// ---------------------------------------------------------------------------

describe("password hashing", () => {
  it("round-trips a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("Str0ngPassphrase!");
    expect(hash).not.toContain("Str0ngPassphrase!");
    expect(await verifyPassword("Str0ngPassphrase!", hash)).toBe(true);
    expect(await verifyPassword("str0ngpassphrase!", hash)).toBe(false);
    expect(await verifyPassword("Str0ngPassphrase", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("salts every hash, so two identical passwords never share a digest", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password-1"), hashPassword("same-password-1")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password-1", a)).toBe(true);
    expect(await verifyPassword("same-password-1", b)).toBe(true);
  });

  it("uses a cost factor of 12 (bcrypt, not a bare digest)", async () => {
    const hash = await hashPassword("cost-check-1");
    expect(hash).toMatch(/^\$2[aby]\$12\$/);
    expect(hash).toHaveLength(60);
  });

  it("returns false — never throws — when the stored hash is corrupt or empty", async () => {
    await expect(verifyPassword("anything", "")).resolves.toBe(false);
    await expect(verifyPassword("anything", "not-a-bcrypt-hash")).resolves.toBe(false);
    await expect(verifyPassword("anything", "$2a$12$short")).resolves.toBe(false);
  });
});

describe("password + login policy", () => {
  it("rejects short, single-case and digit-less passwords with a reason each", () => {
    expect(checkPasswordPolicy("Ab1cdefg")).toEqual({ ok: true, problems: [] });
    expect(checkPasswordPolicy("Ab1cdef").problems).toContain(`at least ${MIN_PASSWORD_LENGTH} characters`);
    expect(checkPasswordPolicy("abcdefg1").problems).toContain("upper and lower case letters");
    expect(checkPasswordPolicy("ABCDEFG1").problems).toContain("upper and lower case letters");
    expect(checkPasswordPolicy("Abcdefgh").problems).toContain("at least one digit");
    expect(checkPasswordPolicy("abc").problems.length).toBeGreaterThanOrEqual(3);
  });

  it("normalizes logins so casing and padding cannot create a second account", () => {
    expect(normalizeLogin("  Admin  ")).toBe("admin");
    expect(normalizeLogin("ADMIN")).toBe("admin");
    expect(normalizeLogin("admin")).toBe(normalizeLogin("AdMiN"));
  });

  it("accepts only the documented login shape", () => {
    expect(checkLoginFormat("ok.user-name_1").ok).toBe(true);
    expect(checkLoginFormat("ab").ok).toBe(false);
    expect(checkLoginFormat("a".repeat(41)).ok).toBe(false);
    expect(checkLoginFormat("has space").ok).toBe(false);
    expect(checkLoginFormat("drop;table").ok).toBe(false);
    expect(checkLoginFormat("<script>x</script>").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Sessions
// ---------------------------------------------------------------------------

describe("createSession", () => {
  it("never stores the raw token — only the peppered SHA-256 of it", async () => {
    const admin = seedAdmin();
    const { token, row } = await signIn(admin.id as string);

    expect(token.length).toBeGreaterThan(20);
    expect(row.tokenHash).toBe(hashSessionToken(token));
    expect(row.tokenHash).not.toBe(token);
    expect(JSON.stringify(store.sessions)).not.toContain(token);
    // the pepper is genuinely part of the digest, not decorative
    expect(hashSessionToken(token)).not.toBe(sha256Hex(token));
  });

  it("issues a distinct high-entropy token per session", async () => {
    const admin = seedAdmin();
    const tokens = new Set<string>();
    for (let i = 0; i < 25; i++) tokens.add((await createSession(admin.id as string)).token);
    expect(tokens.size).toBe(25);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("sets the absolute 7-day expiry and records ip / user agent", async () => {
    const admin = seedAdmin();
    const { session } = await createSession(admin.id as string, "203.0.113.7", "Mozilla/5.0");
    const delta = (session as { expiresAt: Date }).expiresAt.getTime() - Date.now();
    expect(delta).toBeGreaterThan(7 * DAY - 5_000);
    expect(delta).toBeLessThanOrEqual(7 * DAY);
    const row = store.sessions[0]!;
    expect(row.ip).toBe("203.0.113.7");
    expect(row.userAgent).toBe("Mozilla/5.0");
  });

  it("truncates a hostile user-agent to 300 chars", async () => {
    const admin = seedAdmin();
    await createSession(admin.id as string, null, "A".repeat(5_000));
    expect((store.sessions[0]!.userAgent as string).length).toBe(300);
  });
});

describe("sessionCookieOptions", () => {
  it("is httpOnly, SameSite=Lax and path-wide", () => {
    const opts = sessionCookieOptions(new Date(Date.now() + DAY));
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe("lax");
    expect(opts.path).toBe("/");
    expect(opts.expires.getTime()).toBeGreaterThan(Date.now());
  });

  it("marks the cookie Secure in production even when APP_URL is plain http", () => {
    expect(sessionCookieOptions(new Date()).secure).toBe(false); // test env, http APP_URL
    setNodeEnv("production");
    expect(sessionCookieOptions(new Date()).secure).toBe(true);
  });
});

describe("getAuth", () => {
  it("returns null with no cookie at all, without touching the database", async () => {
    cookieJar.value = null;
    expect(await getAuth()).toBeNull();
    expect(store.calls.filter((c) => c.startsWith("session"))).toHaveLength(0);
  });

  it("returns null for a token that matches no session", async () => {
    seedAdmin();
    cookieJar.value = randomToken();
    expect(await getAuth()).toBeNull();
  });

  it("returns the admin identity for a live session and leaks no password hash", async () => {
    const admin = seedAdmin({ login: "owner", name: "Owner", email: "o@x.dev", role: "OWNER" });
    await signIn(admin.id as string);

    const auth = await getAuth();
    expect(auth).not.toBeNull();
    expect(auth!.admin).toEqual({ id: admin.id, login: "owner", email: "o@x.dev", name: "Owner", role: "OWNER" });
    expect(Object.keys(auth!.admin).sort()).toEqual(["email", "id", "login", "name", "role"]);
    expect(JSON.stringify(auth)).not.toContain("passwordHash");
  });

  it("refuses a revoked session", async () => {
    const admin = seedAdmin();
    const { row } = await signIn(admin.id as string);
    expect(await getAuth()).not.toBeNull();
    await revokeSession(row.id as string);
    expect(await getAuth()).toBeNull();
  });

  it("enforces the absolute 7-day expiry even when the session was used a second ago", async () => {
    const admin = seedAdmin();
    await signIn(admin.id as string, { expiresAt: new Date(Date.now() - 1_000), lastSeenAt: new Date() });
    expect(await getAuth()).toBeNull();
  });

  it("enforces the 24-hour idle timeout even though the absolute expiry is days away", async () => {
    const admin = seedAdmin();
    const { row } = await signIn(admin.id as string, { lastSeenAt: new Date(Date.now() - DAY - 60_000) });
    expect(row.expiresAt as Date).toBeInstanceOf(Date);
    expect((row.expiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(await getAuth()).toBeNull();
  });

  it("still accepts a session used just inside the idle window", async () => {
    const admin = seedAdmin();
    await signIn(admin.id as string, { lastSeenAt: new Date(Date.now() - (DAY - 60_000)) });
    expect(await getAuth()).not.toBeNull();
  });

  it("refuses a live session whose admin has been deactivated", async () => {
    const admin = seedAdmin();
    await signIn(admin.id as string);
    expect(await getAuth()).not.toBeNull();
    admin.isActive = false;
    expect(await getAuth()).toBeNull();
  });

  it("bumps lastSeenAt only once the touch interval has passed", async () => {
    const admin = seedAdmin();
    const { row } = await signIn(admin.id as string, { lastSeenAt: new Date(Date.now() - 60_000) });
    const before = (row.lastSeenAt as Date).getTime();
    await getAuth();
    await flush();
    expect((row.lastSeenAt as Date).getTime()).toBe(before);

    row.lastSeenAt = new Date(Date.now() - 10 * 60_000);
    await getAuth();
    await flush();
    expect((row.lastSeenAt as Date).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("keeps the session usable when the lastSeenAt write fails", async () => {
    const admin = seedAdmin();
    const { row } = await signIn(admin.id as string, { lastSeenAt: new Date(Date.now() - 10 * 60_000) });
    const spy = vi.spyOn(prismaMock.session, "update").mockRejectedValueOnce(new Error("write failed"));
    await expect(getAuth()).resolves.not.toBeNull();
    await flush();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(row.id).toBeTruthy();
  });
});

describe("session revocation", () => {
  it("revokeSession is idempotent and never throws on an unknown id", async () => {
    const admin = seedAdmin();
    const { row } = await signIn(admin.id as string);
    await revokeSession(row.id as string);
    const first = row.revokedAt as Date;
    expect(first).toBeInstanceOf(Date);
    await expect(revokeSession("does-not-exist")).resolves.toBeUndefined();
  });

  it("revokeAllSessionsForAdmin kills every live session of that admin and nobody else's", async () => {
    const a = seedAdmin({ login: "a" });
    const b = seedAdmin({ login: "b" });
    const s1 = await createSession(a.id as string);
    const s2 = await createSession(a.id as string);
    const s3 = await createSession(b.id as string);

    await revokeAllSessionsForAdmin(a.id as string);

    const byId = (id: string) => store.sessions.find((s) => s.id === id)!;
    expect(byId((s1.session as { id: string }).id).revokedAt).toBeInstanceOf(Date);
    expect(byId((s2.session as { id: string }).id).revokedAt).toBeInstanceOf(Date);
    expect(byId((s3.session as { id: string }).id).revokedAt).toBeNull();

    cookieJar.value = s1.token;
    expect(await getAuth()).toBeNull();
    cookieJar.value = s3.token;
    expect(await getAuth()).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. RBAC guards
// ---------------------------------------------------------------------------

async function signInAs(role: Role, patch: Row = {}): Promise<Row> {
  const admin = seedAdmin({ login: `${role.toLowerCase()}user`, role, ...patch });
  await signIn(admin.id as string);
  return admin;
}

async function statusOf(fn: () => Promise<unknown>): Promise<number | "ok"> {
  try {
    await fn();
    return "ok";
  } catch (err) {
    if (err instanceof AppError) return err.status;
    throw err;
  }
}

describe("requireAdmin / requireStaff / requireOwner", () => {
  it("requireAdmin throws 401 for an anonymous caller", async () => {
    expect(await statusOf(requireAdmin)).toBe(401);
  });

  it("requireAdmin admits every signed-in role", async () => {
    for (const role of ["OWNER", "ADMIN", "USER"] as Role[]) {
      store.admins.length = 0;
      store.sessions.length = 0;
      await signInAs(role);
      const auth = await requireAdmin();
      expect(auth.admin.role).toBe(role);
    }
  });

  it("requireStaff admits OWNER and ADMIN, refuses USER with 403", async () => {
    await signInAs("OWNER");
    expect(await statusOf(requireStaff)).toBe("ok");

    store.admins.length = 0;
    store.sessions.length = 0;
    await signInAs("ADMIN");
    expect(await statusOf(requireStaff)).toBe("ok");

    store.admins.length = 0;
    store.sessions.length = 0;
    await signInAs("USER");
    expect(await statusOf(requireStaff)).toBe(403);
  });

  it("requireOwner admits OWNER only", async () => {
    await signInAs("OWNER");
    expect(await statusOf(requireOwner)).toBe("ok");

    store.admins.length = 0;
    store.sessions.length = 0;
    await signInAs("ADMIN");
    expect(await statusOf(requireOwner)).toBe(403);

    store.admins.length = 0;
    store.sessions.length = 0;
    await signInAs("USER");
    expect(await statusOf(requireOwner)).toBe(403);
  });

  it("an anonymous caller is 401 (not 403) at every guard — the distinction the UI relies on", async () => {
    expect(await statusOf(requireStaff)).toBe(401);
    expect(await statusOf(requireOwner)).toBe(401);
  });

  it("a revoked session is rejected by the guards, not just by getAuth", async () => {
    const admin = await signInAs("OWNER");
    const row = store.sessions.find((s) => s.adminId === admin.id)!;
    await revokeSession(row.id as string);
    expect(await statusOf(requireOwner)).toBe(401);
  });

  it("requireAuthPage redirects an anonymous visitor to /login", async () => {
    await expect(requireAuthPage()).rejects.toThrow(/NEXT_REDIRECT \/login/);
    await signInAs("USER");
    await expect(requireAuthPage()).resolves.toMatchObject({ admin: { role: "USER" } });
  });
});

// ---------------------------------------------------------------------------
// 4. Account-level authorization
// ---------------------------------------------------------------------------

function grant(adminId: string, accountId: string) {
  store.accountAccess.push({ id: `aa_${store.accountAccess.length + 1}`, adminId, accountId, grantedById: null });
}

async function authFor(role: Role, grants: string[] = []): Promise<AuthContext> {
  store.admins.length = 0;
  store.sessions.length = 0;
  store.accountAccess.length = 0;
  const admin = await signInAs(role);
  for (const g of grants) grant(admin.id as string, g);
  const auth = await getAuth();
  if (!auth) throw new Error("expected a session");
  store.calls.length = 0;
  return auth;
}

describe("accountScope", () => {
  it("gives OWNER and ADMIN an unfiltered where — and never queries the grant table", async () => {
    for (const role of ["OWNER", "ADMIN"] as Role[]) {
      const auth = await authFor(role);
      expect(await accountScope(auth)).toEqual({});
      expect(store.calls.filter((c) => c.startsWith("accountAccess"))).toHaveLength(0);
    }
  });

  it("lets staff narrow to any single account without holding a grant", async () => {
    const auth = await authFor("ADMIN");
    expect(await accountScope(auth, "acc_not_granted")).toEqual({ accountId: "acc_not_granted" });
  });

  it("confines a USER to the accounts actually granted to them", async () => {
    const auth = await authFor("USER", ["acc_a", "acc_b"]);
    expect(await accountScope(auth)).toEqual({ accountId: { in: ["acc_a", "acc_b"] } });
    expect(await accountScope(auth, "acc_b")).toEqual({ accountId: "acc_b" });
  });

  it("a USER with zero grants sees an empty set, not everything", async () => {
    const auth = await authFor("USER", []);
    expect(await accountScope(auth)).toEqual({ accountId: { in: [] } });
    expect(await accountIdScope(auth)).toEqual({ id: { in: [] } });
  });

  it("a USER asking for an account they do not hold gets 403, never a silent empty list", async () => {
    const auth = await authFor("USER", ["acc_a"]);
    await expect(accountScope(auth, "acc_zzz")).rejects.toBeInstanceOf(AppError);
    try {
      await accountScope(auth, "acc_zzz");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as AppError).status).toBe(403);
      expect((err as AppError).code).toBe("FORBIDDEN");
      expect((err as AppError).message).toMatch(/access/i);
    }
  });

  it("another USER's grants never bleed across", async () => {
    const auth = await authFor("USER", ["acc_a"]);
    const other = seedAdmin({ login: "other", role: "USER" });
    grant(other.id as string, "acc_secret");
    expect(await accountScope(auth)).toEqual({ accountId: { in: ["acc_a"] } });
    await expect(accountScope(auth, "acc_secret")).rejects.toBeInstanceOf(AppError);
  });

  it("accountIdScope re-keys the same decision onto InstagramAccount.id", async () => {
    expect(await accountIdScope(await authFor("OWNER"))).toEqual({});
    expect(await accountIdScope(await authFor("USER", ["acc_a", "acc_b"]))).toEqual({ id: { in: ["acc_a", "acc_b"] } });
  });
});

describe("assertAccountAccess", () => {
  it("lets OWNER and ADMIN operate any account with no grant row", async () => {
    for (const role of ["OWNER", "ADMIN"] as Role[]) {
      const auth = await authFor(role);
      await expect(assertAccountAccess(auth, "anything")).resolves.toBeUndefined();
      expect(store.calls.filter((c) => c.startsWith("accountAccess"))).toHaveLength(0);
    }
  });

  it("lets a USER operate only a granted account", async () => {
    const auth = await authFor("USER", ["acc_a", "acc_b"]);
    await expect(assertAccountAccess(auth, "acc_b")).resolves.toBeUndefined();
    await expect(assertAccountAccess(auth, "acc_c")).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a USER with zero grants for every account id", async () => {
    const auth = await authFor("USER", []);
    for (const id of ["acc_a", "", "undefined"]) {
      await expect(assertAccountAccess(auth, id)).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe("grantAccountAccess / grantedAccountIds", () => {
  it("is idempotent — a repeated grant does not duplicate the row", async () => {
    const admin = seedAdmin({ role: "USER" });
    await grantAccountAccess(admin.id as string, "acc_a", "granter");
    await grantAccountAccess(admin.id as string, "acc_a", "granter");
    expect(store.accountAccess).toHaveLength(1);
    expect(await grantedAccountIds(admin.id as string)).toEqual(["acc_a"]);
  });

  it("reads back only that admin's grants", async () => {
    const one = seedAdmin({ login: "one", role: "USER" });
    const two = seedAdmin({ login: "two", role: "USER" });
    await grantAccountAccess(one.id as string, "acc_a");
    await grantAccountAccess(two.id as string, "acc_b");
    expect(await grantedAccountIds(one.id as string)).toEqual(["acc_a"]);
    expect(await grantedAccountIds(two.id as string)).toEqual(["acc_b"]);
  });
});

describe("pure account-filter decisions", () => {
  it("resolveAccountFilter covers every role / request combination", () => {
    expect(resolveAccountFilter("OWNER", [], null)).toEqual({ kind: "all" });
    expect(resolveAccountFilter("ADMIN", [], undefined)).toEqual({ kind: "all" });
    expect(resolveAccountFilter("OWNER", [], "x")).toEqual({ kind: "one", id: "x" });
    expect(resolveAccountFilter("USER", ["x"], "x")).toEqual({ kind: "one", id: "x" });
    expect(resolveAccountFilter("USER", ["x"], "y")).toEqual({ kind: "forbidden", id: "y" });
    expect(resolveAccountFilter("USER", [], null)).toEqual({ kind: "many", ids: [] });
    // an empty-string request is falsy and must fall through to the list scope,
    // not be treated as "account named ''"
    expect(resolveAccountFilter("USER", ["x"], "")).toEqual({ kind: "many", ids: ["x"] });
  });

  it("whereFromFilter turns a forbidden filter into a 403 rather than a where", () => {
    expect(whereFromFilter({ kind: "all" })).toEqual({});
    expect(whereFromFilter({ kind: "one", id: "x" })).toEqual({ accountId: "x" });
    expect(whereFromFilter({ kind: "many", ids: [] })).toEqual({ accountId: { in: [] } });
    expect(() => whereFromFilter({ kind: "forbidden", id: "x" })).toThrowError(AppError);
  });

  it("isStaff is the single definition of 'staff'", () => {
    const ctx = (role: Role) => ({ admin: { id: "1", login: "l", email: null, name: "n", role } });
    expect(isStaff(ctx("OWNER"))).toBe(true);
    expect(isStaff(ctx("ADMIN"))).toBe(true);
    expect(isStaff(ctx("USER"))).toBe(false);
  });
});

describe("wouldLeaveUserWithoutAccounts", () => {
  it("only ever fires for a final role of USER", () => {
    expect(wouldLeaveUserWithoutAccounts({ finalRole: "OWNER", roleIsChanging: true, providedAccountIds: [], existingGrantCount: 0 })).toBe(false);
    expect(wouldLeaveUserWithoutAccounts({ finalRole: "ADMIN", roleIsChanging: true, providedAccountIds: [], existingGrantCount: 0 })).toBe(false);
  });

  it("blocks an explicitly empty (or duplicate-only-empty) account list", () => {
    expect(wouldLeaveUserWithoutAccounts({ finalRole: "USER", roleIsChanging: true, providedAccountIds: [], existingGrantCount: 5 })).toBe(true);
    expect(wouldLeaveUserWithoutAccounts({ finalRole: "USER", roleIsChanging: false, providedAccountIds: [], existingGrantCount: 5 })).toBe(true);
  });

  it("accepts a non-empty list and de-dupes before judging", () => {
    expect(wouldLeaveUserWithoutAccounts({ finalRole: "USER", roleIsChanging: true, providedAccountIds: ["a", "a"], existingGrantCount: 0 })).toBe(false);
  });

  it("when the request does not touch accountIds, only a role change into USER is judged", () => {
    expect(wouldLeaveUserWithoutAccounts({ finalRole: "USER", roleIsChanging: false, existingGrantCount: 0 })).toBe(false);
    expect(wouldLeaveUserWithoutAccounts({ finalRole: "USER", roleIsChanging: true, existingGrantCount: 0 })).toBe(true);
    expect(wouldLeaveUserWithoutAccounts({ finalRole: "USER", roleIsChanging: true, existingGrantCount: 1 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Request security: origin, ip, rate limits
// ---------------------------------------------------------------------------

function mutating(method: string, opts: { origin?: string; referer?: string; cookie?: boolean } = {}) {
  const headers = new Headers();
  if (opts.origin) headers.set("origin", opts.origin);
  if (opts.referer) headers.set("referer", opts.referer);
  if (opts.cookie) headers.set("cookie", "ig_admin_session=abc");
  return new NextRequest("http://localhost:3000/api/anything", { method, headers });
}

const allows = (req: NextRequest): boolean => {
  try {
    assertSameOrigin(req);
    return true;
  } catch {
    return false;
  }
};

describe("assertSameOrigin", () => {
  it("never blocks a safe method, whatever the origin", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      expect(allows(mutating(method, { origin: "https://evil.example" }))).toBe(true);
    }
  });

  it("accepts the app's own origin on every mutating verb", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(allows(mutating(method, { origin: "http://localhost:3000" }))).toBe(true);
    }
  });

  it("rejects a cross-origin POST and says which origin it was", () => {
    const req = mutating("POST", { origin: "https://evil.example" });
    expect(allows(req)).toBe(false);
    try {
      assertSameOrigin(req);
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as AppError;
      expect(e.status).toBe(403);
      expect(e.code).toBe("FORBIDDEN");
      expect(e.reason).toContain("https://evil.example");
      expect(e.fix).toContain("TRUSTED_ORIGINS");
    }
  });

  it("rejects a look-alike host that merely contains the trusted one", () => {
    expect(allows(mutating("POST", { origin: "http://localhost:3000.evil.example" }))).toBe(false);
    expect(allows(mutating("POST", { origin: "http://notlocalhost:3000" }))).toBe(false);
  });

  it("falls back to Referer when Origin is missing", () => {
    expect(allows(mutating("POST", { referer: "http://localhost:3000/login" }))).toBe(true);
    expect(allows(mutating("POST", { referer: "https://evil.example/x" }))).toBe(false);
  });

  it("rejects a malformed / opaque Origin instead of ignoring it", () => {
    expect(allows(mutating("POST", { origin: "not-a-url" }))).toBe(false);
    expect(allows(mutating("POST", { origin: "null" }))).toBe(false);
  });

  it("allows a header-less non-browser call only when it carries no cookies", () => {
    expect(allows(mutating("POST"))).toBe(true);
    expect(allows(mutating("POST", { cookie: true }))).toBe(false);
  });

  it("trusts loopback/LAN in development but NOT in production", () => {
    expect(allows(mutating("POST", { origin: "http://127.0.0.1:3000" }))).toBe(true);
    expect(allows(mutating("POST", { origin: "http://192.168.1.50:3000" }))).toBe(true);
    expect(allows(mutating("POST", { origin: "http://localhost:3001" }))).toBe(true);

    setNodeEnv("production");
    expect(allows(mutating("POST", { origin: "http://localhost:3000" }))).toBe(true); // APP_URL itself
    expect(allows(mutating("POST", { origin: "http://127.0.0.1:3000" }))).toBe(false);
    expect(allows(mutating("POST", { origin: "http://10.0.0.5:3000" }))).toBe(false);
    expect(allows(mutating("POST", { origin: "https://evil.example" }))).toBe(false);
  });

  it("honours TRUSTED_ORIGINS, including a bare host:port entry, in production", () => {
    setNodeEnv("production");
    expect(allows(mutating("POST", { origin: "https://ops.example.com" }))).toBe(false);
    process.env.TRUSTED_ORIGINS = "https://ops.example.com, bare.example:8080";
    expect(trustedHosts().has("ops.example.com")).toBe(true);
    expect(allows(mutating("POST", { origin: "https://ops.example.com" }))).toBe(true);
    expect(allows(mutating("POST", { origin: "http://bare.example:8080" }))).toBe(true);
    expect(allows(mutating("POST", { origin: "http://bare.example:9090" }))).toBe(false);
  });

  it("isLocalHostname draws the private/public line where the RFCs do", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "::1", "[::1]", "10.0.0.1", "192.168.0.1", "172.16.0.1", "172.31.0.1"]) {
      expect(isLocalHostname(h), h).toBe(true);
    }
    for (const h of ["evil.com", "localhost.evil.com", "8.8.8.8", "172.15.0.1", "172.32.0.1", "11.0.0.1", "192.169.0.1"]) {
      expect(isLocalHostname(h), h).toBe(false);
    }
  });
});

describe("clientIp", () => {
  const withHeaders = (headers: Record<string, string>) =>
    new NextRequest("http://localhost:3000/api/auth/login", { method: "POST", headers: new Headers(headers) });

  it("reads X-Forwarded-For from the RIGHT, so a spoofed left-hand entry buys nothing", () => {
    expect(clientIp(withHeaders({ "x-forwarded-for": "203.0.113.7" }))).toBe("203.0.113.7");
    // the attacker prepends a victim address on every request…
    expect(clientIp(withHeaders({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(withHeaders({ "x-forwarded-for": "2.2.2.2, 3.3.3.3, 203.0.113.7" }))).toBe("203.0.113.7");
    // …and still lands in the same rate-limit bucket
    const spoofed = new Set(
      ["a", "b", "c"].map((seed) => clientIp(withHeaders({ "x-forwarded-for": `9.9.9.${seed.length}, 203.0.113.7` }))),
    );
    expect([...spoofed]).toEqual(["203.0.113.7"]);
  });

  it("skips extra hops only when TRUSTED_PROXY_HOPS says so, and never falls back to caller-controlled input", () => {
    expect(clientIp(withHeaders({ "x-forwarded-for": "1.1.1.1, 203.0.113.7, 10.0.0.5" }))).toBe("10.0.0.5");
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(clientIp(withHeaders({ "x-forwarded-for": "1.1.1.1, 203.0.113.7, 10.0.0.5" }))).toBe("203.0.113.7");
    process.env.TRUSTED_PROXY_HOPS = "9";
    expect(clientIp(withHeaders({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }))).toBe("203.0.113.7");
    process.env.TRUSTED_PROXY_HOPS = "not-a-number";
    expect(clientIp(withHeaders({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" }))).toBe("203.0.113.7");
  });

  it("prefers a platform header only when one is actually configured", () => {
    const headers = { "cf-connecting-ip": "198.51.100.9", "x-forwarded-for": "203.0.113.7" };
    expect(clientIp(withHeaders(headers))).toBe("203.0.113.7");
    process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
    expect(clientIp(withHeaders(headers))).toBe("198.51.100.9");
    delete process.env.TRUSTED_IP_HEADER;
    process.env.VERCEL = "1";
    expect(clientIp(withHeaders({ ...headers, "x-vercel-forwarded-for": "198.51.100.1" }))).toBe("198.51.100.1");
    // a configured platform header that is absent falls back rather than failing
    expect(clientIp(withHeaders(headers))).toBe("203.0.113.7");
  });

  it("normalizes ports and IPv6 and admits when it knows nothing", () => {
    expect(clientIp(withHeaders({ "x-forwarded-for": "203.0.113.7:51234" }))).toBe("203.0.113.7");
    expect(clientIp(withHeaders({ "x-forwarded-for": "[2001:DB8::1]:443" }))).toBe("2001:db8::1");
    expect(clientIp(withHeaders({ "x-real-ip": "203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(withHeaders({ "x-forwarded-for": "  , ,  ", "x-real-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(clientIp(withHeaders({}))).toBe("unknown");
    // a 4KB header cannot become a 4KB rate-limit key
    expect(clientIp(withHeaders({ "x-forwarded-for": "A".repeat(4096) })).length).toBeLessThanOrEqual(64);
  });
});

describe("enforceRateLimit", () => {
  it("allows exactly `limit` calls, then throws a 429 that says how long to wait", () => {
    for (let i = 0; i < 3; i++) expect(() => enforceRateLimit("qa:k1", 3, 60_000)).not.toThrow();
    try {
      enforceRateLimit("qa:k1", 3, 60_000);
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as AppError;
      expect(e).toBeInstanceOf(AppError);
      expect(e.status).toBe(429);
      expect(e.code).toBe("RATE_LIMITED");
      expect(e.fix).toMatch(/Wait \d+s/);
    }
  });

  it("counts each key separately", () => {
    for (let i = 0; i < 3; i++) enforceRateLimit("qa:k2", 3, 60_000);
    expect(() => enforceRateLimit("qa:k2", 3, 60_000)).toThrow();
    expect(() => enforceRateLimit("qa:k3", 3, 60_000)).not.toThrow();
  });
});

describe("rateLimit windowing", () => {
  function atFakeTime(run: (advanceTo: (ms: number) => void) => void) {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = new Date("2026-03-01T00:00:00.000Z").getTime();
      vi.setSystemTime(t0);
      _resetRateLimiter();
      run((ms) => vi.setSystemTime(t0 + ms));
    } finally {
      vi.useRealTimers();
    }
  }

  it("reports remaining, then blocks with a retryAfter that matches the oldest timestamp", () => {
    atFakeTime((advanceTo) => {
      expect(rateLimit("k", 3, 60_000)).toEqual({ allowed: true, remaining: 2, retryAfterSec: 0 });
      advanceTo(10_000);
      expect(rateLimit("k", 3, 60_000).remaining).toBe(1);
      expect(rateLimit("k", 3, 60_000).remaining).toBe(0);
      const blocked = rateLimit("k", 3, 60_000);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.retryAfterSec).toBe(50); // the first hit expires 50s from now
    });
  });

  it("slides: one slot frees as each individual timestamp leaves the window", () => {
    atFakeTime((advanceTo) => {
      rateLimit("k", 2, 60_000);
      advanceTo(30_000);
      rateLimit("k", 2, 60_000);
      advanceTo(40_000);
      expect(rateLimit("k", 2, 60_000).allowed).toBe(false);
      advanceTo(60_001); // first hit has aged out, second has not
      expect(rateLimit("k", 2, 60_000).allowed).toBe(true);
      expect(rateLimit("k", 2, 60_000).allowed).toBe(false);
    });
  });

  it("fully resets once the whole window has passed", () => {
    atFakeTime((advanceTo) => {
      for (let i = 0; i < LIMITS.LOGIN.limit; i++) rateLimit("login:x", LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs);
      expect(rateLimit("login:x", LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs).allowed).toBe(false);
      advanceTo(LIMITS.LOGIN.windowMs + 1_000);
      expect(rateLimit("login:x", LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs)).toEqual({
        allowed: true,
        remaining: LIMITS.LOGIN.limit - 1,
        retryAfterSec: 0,
      });
    });
  });

  it("a short-window key's sweep must not prune a long-window key", () => {
    atFakeTime((advanceTo) => {
      for (let i = 0; i < LIMITS.LOGIN.limit; i++) rateLimit("login:y", LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs);
      advanceTo(2 * 60_000); // past API_WRITE's window, nowhere near LOGIN's
      rateLimit("api-write:other", LIMITS.API_WRITE.limit, LIMITS.API_WRITE.windowMs);
      expect(rateLimit("login:y", LIMITS.LOGIN.limit, LIMITS.LOGIN.windowMs).allowed).toBe(false);
    });
  });

  it("resetRateLimit forgets one key and only that key", () => {
    for (let i = 0; i < 3; i++) rateLimit("a", 3, 60_000);
    for (let i = 0; i < 3; i++) rateLimit("b", 3, 60_000);
    resetRateLimit("a");
    expect(rateLimit("a", 3, 60_000).allowed).toBe(true);
    expect(rateLimit("b", 3, 60_000).allowed).toBe(false);
  });

  it("publishes an honest description of its own scope", () => {
    const info = rateLimiterInfo();
    expect(info.scope).toBe("per-instance");
    expect(info.note).toMatch(/instance/i);
    expect(info.durableLoginLockout).toBe(true);
    expect(info.loginLockout).toEqual({ windowMinutes: 15, perLogin: LOGIN_LOCKOUT.perLogin, perIp: LOGIN_LOCKOUT.perIp });
  });
});

describe("route() default write limit", () => {
  const handler = route(async () => ok({ done: true }));
  const write = (method = "POST", cookie = "ig_admin_session=token-alpha") => {
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    return new NextRequest("http://localhost:3000/api/anything", { method, headers });
  };

  it("keys the bucket by the HASH of the session token, never the token itself", async () => {
    const token = "token-secret-value";
    const res = await handler(write("POST", `ig_admin_session=${token}`), ROUTE_CTX);
    expect(res.status).toBe(200);
    // the bucket the handler just used is the hashed one — proving the key formula
    expect(rateLimit(`api-write:${sha256Hex(token).slice(0, 32)}`, 1, 60_000).allowed).toBe(false);
    // …and NOT a bucket keyed by the raw token
    expect(rateLimit(`api-write:${token}`, 1, 60_000).allowed).toBe(true);
  });

  it("stops one session at API_WRITE without touching another, and never limits reads", async () => {
    for (let i = 0; i < LIMITS.API_WRITE.limit; i++) {
      expect((await handler(write(), ROUTE_CTX)).status).toBe(200);
    }
    const blocked = await handler(write(), ROUTE_CTX);
    expect(blocked.status).toBe(429);
    expect((await envelope(blocked)).error?.code).toBe("RATE_LIMITED");

    expect((await handler(write("POST", "ig_admin_session=token-beta"), ROUTE_CTX)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await handler(write("GET"), ROUTE_CTX)).status).toBe(200);
  });

  it("leaves session-less callers (webhooks, cron) to their own route limits", async () => {
    for (let i = 0; i < LIMITS.API_WRITE.limit + 3; i++) {
      expect((await handler(write("POST", ""), ROUTE_CTX)).status).toBe(200);
    }
  });

  it("maps a thrown AppError to its envelope and an unexpected throw to a 500 without leaking it", async () => {
    const boom = route(async () => {
      throw new Error("internal detail: connection string postgres://user:pw@host");
    });
    const res = await boom(write("POST", ""), ROUTE_CTX);
    expect(res.status).toBe(500);
    const body = await envelope(res);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("postgres://");

    const denied = route(async () => {
      throw new AppError("FORBIDDEN", "nope");
    });
    expect((await denied(write("POST", ""), ROUTE_CTX)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 6. The durable login lockout, driven through the real route
// ---------------------------------------------------------------------------

describe("loginLockout (pure decision)", () => {
  const NOW = new Date("2026-03-01T12:00:00.000Z").getTime();
  const failures = (count: number, newestAgoMs = 0) =>
    Array.from({ length: count }, (_, i) => new Date(NOW - newestAgoMs - i * 60_000));

  it("lets ordinary mistyping through", () => {
    expect(loginLockout({ forLogin: failures(LOGIN_LOCKOUT.perLogin - 1), forIp: failures(LOGIN_LOCKOUT.perIp - 1) }, NOW)).toEqual({
      locked: false,
      scope: null,
      retryAfterSec: 0,
    });
  });

  it("locks the login at its threshold, and prefers the login scope over the ip scope", () => {
    const res = loginLockout({ forLogin: failures(LOGIN_LOCKOUT.perLogin), forIp: failures(LOGIN_LOCKOUT.perIp) }, NOW);
    expect(res.locked).toBe(true);
    expect(res.scope).toBe("login");
  });

  it("locks an address spraying many different logins", () => {
    const res = loginLockout({ forLogin: failures(2), forIp: failures(LOGIN_LOCKOUT.perIp) }, NOW);
    expect(res.locked).toBe(true);
    expect(res.scope).toBe("ip");
  });

  it("quotes the lift time from the failure that drops the count below the threshold", () => {
    const res = loginLockout({ forLogin: failures(LOGIN_LOCKOUT.perLogin * 2), forIp: [] }, NOW);
    const decisiveAgo = (LOGIN_LOCKOUT.perLogin - 1) * 60_000;
    expect(res.retryAfterSec).toBe(Math.ceil((LOGIN_LOCKOUT.windowMs - decisiveAgo) / 1000));
    expect(res.retryAfterSec).toBeGreaterThan(0);
  });

  it("never returns NaN when a timestamp is unusable", () => {
    const forLogin = failures(LOGIN_LOCKOUT.perLogin);
    forLogin[LOGIN_LOCKOUT.perLogin - 1] = new Date(Number.NaN);
    expect(loginLockout({ forLogin, forIp: [] }, NOW).retryAfterSec).toBe(Math.ceil(LOGIN_LOCKOUT.windowMs / 1000));
  });
});

describe("POST /api/auth/login — durable lockout end to end", () => {
  const ATTACKER_IP = "198.51.100.10";

  it("counts the LOGIN_FAILED rows the route itself writes, and locks the login at the threshold", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT.perLogin; i++) {
      const res = await attemptLogin("ghost", "guess-me", ATTACKER_IP);
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    expect(store.auditLogs.filter((r) => r.action === "LOGIN_FAILED")).toHaveLength(LOGIN_LOCKOUT.perLogin);

    const locked = await attemptLogin("ghost", "guess-me", ATTACKER_IP);
    expect(locked.status).toBe(429);
    const body = await envelope(locked);
    expect(body.error?.code).toBe("RATE_LIMITED");
    expect(body.error?.message).toMatch(/Too many failed sign-in attempts/i);
    expect(body.error?.reason).toMatch(/login has failed/i);
  });

  it("cannot be bypassed by changing the casing or padding of the login", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT.perLogin; i++) await attemptLogin("ghost", "guess-me", ATTACKER_IP);
    for (const variant of ["GHOST", "GhOsT", "  ghost  "]) {
      const res = await attemptLogin(variant, "guess-me", ATTACKER_IP);
      expect(res.status, variant).toBe(429);
      expect((await envelope(res)).error?.reason).toMatch(/login has failed/i);
    }
  });

  it("writes no new failure row while locked, so the lock decays instead of renewing itself", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT.perLogin; i++) await attemptLogin("ghost", "guess-me", ATTACKER_IP);
    const before = store.auditLogs.filter((r) => r.action === "LOGIN_FAILED").length;
    await attemptLogin("ghost", "guess-me", ATTACKER_IP);
    expect(store.auditLogs.filter((r) => r.action === "LOGIN_FAILED")).toHaveLength(before);
    expect(store.auditLogs.some((r) => r.action === "LOGIN_LOCKED")).toBe(true);
  });

  it("does not check the password at all once locked (no free bcrypt work, no account enumeration)", async () => {
    const hash = await hashPassword("RightPassword1");
    seedAdmin({ login: "target", passwordHash: hash });
    for (let i = 0; i < LOGIN_LOCKOUT.perLogin; i++) await attemptLogin("target", "wrong", ATTACKER_IP);

    store.calls.length = 0;
    const res = await attemptLogin("target", "RightPassword1", ATTACKER_IP);
    expect(res.status).toBe(429); // even the CORRECT password is refused while locked
    expect(store.calls.filter((c) => c === "admin.findUnique")).toHaveLength(0);
  });

  it("locks one login without locking a different login from the same address (below the ip threshold)", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT.perLogin; i++) await attemptLogin("ghost", "guess-me", ATTACKER_IP);
    expect((await attemptLogin("ghost", "x", ATTACKER_IP)).status).toBe(429);
    expect((await attemptLogin("someone-else", "x", ATTACKER_IP)).status).toBe(401);
  });

  it("locks an address that sprays many different logins, by ip scope", async () => {
    const sprayIp = "198.51.100.77";
    for (let i = 0; i < LOGIN_LOCKOUT.perIp; i++) {
      auditRow({ ip: sprayIp, after: { login: `victim${i}` }, createdAt: new Date(Date.now() - i * 1_000) });
    }
    const res = await attemptLogin("brand-new-name", "x", sprayIp);
    expect(res.status).toBe(429);
    expect((await envelope(res)).error?.reason).toMatch(/address has failed/i);

    // a different address is untouched
    expect((await attemptLogin("brand-new-name-2", "x", "198.51.100.200")).status).toBe(401);
  });

  it("ignores failures older than the lockout window", async () => {
    const old = Date.now() - (LOGIN_LOCKOUT.windowMs + 60_000);
    for (let i = 0; i < LOGIN_LOCKOUT.perLogin * 2; i++) {
      auditRow({ ip: ATTACKER_IP, after: { login: "stale" }, createdAt: new Date(old - i * 1_000) });
    }
    expect((await attemptLogin("stale", "x", ATTACKER_IP)).status).toBe(401);
  });

  it("never locks on the un-attributable 'unknown' address — that would be a self-inflicted outage", async () => {
    for (let i = 0; i < LOGIN_LOCKOUT.perIp + 5; i++) {
      const res = await attemptLogin(`nobody${i}`, "x", null);
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    expect(store.auditLogs.every((r) => r.action !== "LOGIN_LOCKED")).toBe(true);
  });

  it("degrades open rather than 500ing when the lockout count query fails", async () => {
    const hash = await hashPassword("RightPassword1");
    seedAdmin({ login: "degrade", passwordHash: hash });
    store.failNextAuditFind = true;
    const res = await attemptLogin("degrade", "RightPassword1", ATTACKER_IP);
    expect(res.status).toBe(200);
  });
});

describe("POST /api/auth/login — credentials, sessions and the in-process limiter", () => {
  let hash = "";
  beforeAll(async () => {
    hash = await hashPassword("RightPassword1");
  });

  it("signs a valid admin in, sets an httpOnly cookie, and stores only the token hash", async () => {
    const admin = seedAdmin({ login: "boss", role: "OWNER", passwordHash: hash });
    const res = await attemptLogin("BOSS", "RightPassword1");
    expect(res.status).toBe(200);

    const body = await envelope(res);
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ admin: { id: admin.id, login: "boss", name: "Test Admin", role: "OWNER" } });
    expect(JSON.stringify(body)).not.toContain("passwordHash");

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Path=\//);

    const token = tokenFromSetCookie(res);
    expect(token).toBeTruthy();
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]!.tokenHash).toBe(hashSessionToken(token!));
    expect(JSON.stringify(store.sessions)).not.toContain(token!);

    // and the cookie actually authenticates
    cookieJar.value = token;
    expect((await getAuth())?.admin.login).toBe("boss");

    await flush();
    expect(store.auditLogs.some((r) => r.action === "LOGIN" && r.adminId === admin.id)).toBe(true);
    expect(admin.lastLoginAt).toBeInstanceOf(Date);
  });

  it("gives byte-identical answers for unknown login, wrong password and disabled account", async () => {
    seedAdmin({ login: "real", passwordHash: hash });
    seedAdmin({ login: "disabled", passwordHash: hash, isActive: false });

    const unknown = await envelope(await attemptLogin("nobody-here", "RightPassword1"));
    const wrong = await envelope(await attemptLogin("real", "WrongPassword1"));
    const off = await envelope(await attemptLogin("disabled", "RightPassword1"));

    expect(unknown.error?.message).toBe("Incorrect login or password");
    expect(wrong).toEqual(unknown);
    expect(off).toEqual(unknown);
    expect(store.sessions).toHaveLength(0);
  });

  it("records WHY it failed in the audit row even though the response does not", async () => {
    seedAdmin({ login: "real", passwordHash: hash });
    seedAdmin({ login: "disabled", passwordHash: hash, isActive: false });
    await attemptLogin("real", "WrongPassword1");
    await attemptLogin("disabled", "RightPassword1");
    await attemptLogin("nobody-here", "x");

    const errors = store.auditLogs.filter((r) => r.action === "LOGIN_FAILED").map((r) => r.error);
    expect(errors).toEqual(["bad password", "account disabled", "unknown login"]);
    // the audited login is the normalized one the lockout counts on
    expect(store.auditLogs.map((r) => (r.after as { login: string }).login)).toEqual(["real", "disabled", "nobody-here"]);
  });

  it("refuses a cross-origin sign-in attempt before doing anything else", async () => {
    seedAdmin({ login: "real", passwordHash: hash });
    const res = await loginRoute(
      loginRequest({ login: "real", password: "RightPassword1" }, { origin: "https://evil.example" }),
      ROUTE_CTX,
    );
    expect(res.status).toBe(403);
    expect(store.sessions).toHaveLength(0);
    expect(store.auditLogs).toHaveLength(0);
  });

  it("validates the body shape", async () => {
    expect((await loginRoute(loginRequest({ login: "" }), ROUTE_CTX)).status).toBe(400);
    expect((await loginRoute(loginRequest({ login: "x", password: "" }), ROUTE_CTX)).status).toBe(400);
    expect((await loginRoute(loginRequest({ login: "a".repeat(65), password: "p" }), ROUTE_CTX)).status).toBe(400);
    const bad = new NextRequest("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: new Headers({ origin: "http://localhost:3000", "content-type": "application/json" }),
      body: "{not json",
    });
    expect((await loginRoute(bad, ROUTE_CTX)).status).toBe(400);
  });

  it("stops brute force from one address against one login at LIMITS.LOGIN, before the durable lockout", async () => {
    seedAdmin({ login: "real", passwordHash: hash });
    for (let i = 0; i < LIMITS.LOGIN.limit; i++) {
      const res = await loginRoute(loginRequest({ login: "real", password: "nope" }, { ip: "203.0.113.50" }), ROUTE_CTX);
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    const blocked = await loginRoute(loginRequest({ login: "real", password: "nope" }, { ip: "203.0.113.50" }), ROUTE_CTX);
    expect(blocked.status).toBe(429);
    expect((await envelope(blocked)).error?.message).toBe("Too many requests");
  });

  it("caps credential spraying from one address across rotating logins at LIMITS.LOGIN_IP", async () => {
    for (let i = 0; i < LIMITS.LOGIN_IP.limit; i++) {
      const res = await loginRoute(loginRequest({ login: `victim${i}`, password: "x" }, { ip: "203.0.113.60" }), ROUTE_CTX);
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    const blocked = await loginRoute(loginRequest({ login: "victim999", password: "x" }, { ip: "203.0.113.60" }), ROUTE_CTX);
    expect(blocked.status).toBe(429);
    expect((await envelope(blocked)).error?.message).toBe("Too many requests");
  });

  it("a correct password clears that address's failure bucket, so an admin cannot lock themselves out", async () => {
    seedAdmin({ login: "real", passwordHash: hash });
    const ip = "203.0.113.70";
    for (let i = 0; i < LIMITS.LOGIN.limit - 1; i++) {
      await loginRoute(loginRequest({ login: "real", password: "nope" }, { ip }), ROUTE_CTX);
    }
    const good = await loginRoute(loginRequest({ login: "real", password: "RightPassword1" }, { ip }), ROUTE_CTX);
    expect(good.status).toBe(200);
    // without the reset the next attempt would already be the 6th in the window
    const after = await loginRoute(loginRequest({ login: "real", password: "nope" }, { ip }), ROUTE_CTX);
    expect(after.status).toBe(401);
  });
});

describe("/api/auth/me and /api/auth/logout", () => {
  it("me is 401 anonymously and returns the identity when signed in", async () => {
    const anon = await meRoute(new NextRequest("http://localhost:3000/api/auth/me"), ROUTE_CTX);
    expect(anon.status).toBe(401);
    expect((await envelope(anon)).error?.code).toBe("UNAUTHORIZED");

    const admin = seedAdmin({ login: "boss", role: "OWNER" });
    await signIn(admin.id as string);
    const res = await meRoute(new NextRequest("http://localhost:3000/api/auth/me"), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect((await envelope(res)).data).toEqual({ admin: { id: admin.id, login: "boss", email: null, name: "Test Admin", role: "OWNER" } });
  });

  it("logout revokes the session server-side and clears the cookie", async () => {
    const admin = seedAdmin();
    const { row } = await signIn(admin.id as string);
    const res = await logoutRoute(mutating("POST", { origin: "http://localhost:3000" }), ROUTE_CTX);
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toMatch(/ig_admin_session=;?/);
    expect(row.revokedAt).toBeInstanceOf(Date);
    // the stolen cookie is dead even if the browser kept it
    expect(await getAuth()).toBeNull();
    expect(store.auditLogs.some((r) => r.action === "LOGOUT")).toBe(true);
  });

  it("logout refuses a cross-origin call", async () => {
    const admin = seedAdmin();
    const { row } = await signIn(admin.id as string);
    const res = await logoutRoute(mutating("POST", { origin: "https://evil.example" }), ROUTE_CTX);
    expect(res.status).toBe(403);
    expect(row.revokedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Middleware allowlist and the post-login redirect
// ---------------------------------------------------------------------------

describe("isPublicPath", () => {
  it("lets every allowlisted entry through", () => {
    const publicPaths = [
      "/login",
      "/f/summer-promo",
      "/connect/tok_123",
      "/api/connect/start",
      "/api/meta/oauth/callback",
      "/api/auth/login",
      "/api/webhooks/instagram",
      "/api/webhooks/stripe",
      "/api/cron/worker",
      "/api/health",
      "/api/setup-status",
      "/api/leads/public",
      "/m/abc123.jpg",
      "/r/doc.pdf",
      "/v/signed-token",
      "/_next/static/chunk.js",
      "/favicon.ico",
    ];
    for (const p of publicPaths) expect(isPublicPath(p), p).toBe(true);
  });

  it("does NOT let a look-alike prefix through", () => {
    const gated = [
      "/finance",
      "/f",
      "/verify",
      "/v",
      "/reports",
      "/r",
      "/media",
      "/m",
      "/connections",
      "/connect",
      "/api/connections",
      "/api/auth/logout",
      "/api/auth/me",
      "/api/meta/oauth/start",
      "/api/leads",
      "/dashboard",
      "/admin",
      "/api/admin/admins",
      "/api/instagram/accounts",
      "/api/video/assets",
      "/api/billing/overview",
      "/api/settings/global",
      "",
    ];
    for (const p of gated) expect(isPublicPath(p), p).toBe(false);
  });

  it("every path the middleware lets through unauthenticated is one that authenticates itself", () => {
    // /api/leads/public is the public lead form; /api/leads (the CRM list) must not inherit it
    expect(isPublicPath("/api/leads/public")).toBe(true);
    expect(isPublicPath("/api/leads/public/anything")).toBe(true);
    expect(isPublicPath("/api/leads/123")).toBe(false);
  });

  /**
   * DEFECT (fixed): the allowlist was matched with a bare `startsWith`, so an
   * entry shadowed any sibling beginning with the same letters. Next.js routes
   * /api/leads/publicXYZ to /api/leads/[id] — a CRM lead — and that request
   * skipped the middleware's session gate entirely. Same shape for every
   * slash-less entry in the list.
   */
  it("matches whole path segments, so an allowlisted path cannot shadow a sibling route", () => {
    expect(isPublicPath("/api/leads/publicXYZ")).toBe(false);
    expect(isPublicPath("/api/leads/public-ish")).toBe(false);
    expect(isPublicPath("/api/webhooksX")).toBe(false);
    expect(isPublicPath("/api/cronjobs")).toBe(false);
    expect(isPublicPath("/api/healthz")).toBe(false);
    expect(isPublicPath("/api/setup-status-secret")).toBe(false);
    expect(isPublicPath("/api/auth/login-as")).toBe(false);
    expect(isPublicPath("/api/meta/oauth/callbackX")).toBe(false);
    expect(isPublicPath("/loginX")).toBe(false);
    expect(isPublicPath("/_nextX")).toBe(false);
    // …while the genuine sub-paths still pass
    expect(isPublicPath("/api/webhooks/instagram")).toBe(true);
    expect(isPublicPath("/api/cron/worker")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/_next/static/x.js")).toBe(true);
  });
});

describe("middleware gate", () => {
  const req = (pathname: string, cookie?: string) => {
    const headers = new Headers();
    if (cookie) headers.set("cookie", cookie);
    return new NextRequest(`http://localhost:3000${pathname}`, { headers });
  };

  it("answers an anonymous API call with a 401 JSON envelope, not an HTML redirect", async () => {
    const res = middleware(req("/api/admin/admins"));
    expect(res.status).toBe(401);
    expect(res.headers.get("location")).toBeNull();
    const body = (await res.json()) as Envelope;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("UNAUTHORIZED");
  });

  it("redirects an anonymous page view to /login with an escaped next", () => {
    const res = middleware(req("/dashboard"));
    expect([302, 307, 308]).toContain(res.status);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).toContain(`next=${encodeURIComponent("/dashboard")}`);
  });

  it("does not add a next param for the root", () => {
    const location = middleware(req("/")).headers.get("location") ?? "";
    expect(location).toContain("/login");
    expect(location).not.toContain("next=");
  });

  it("lets a cookie-bearing request continue (the real check is in the route/layout)", () => {
    const res = middleware(req("/dashboard", "ig_admin_session=whatever"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("treats an empty cookie value as no session", () => {
    const res = middleware(req("/dashboard", "ig_admin_session="));
    expect(res.headers.get("location")).toContain("/login");
  });

  it("never gates a public path, with or without a cookie", () => {
    expect(middleware(req("/r/file.pdf")).headers.get("location")).toBeNull();
    expect(middleware(req("/api/webhooks/instagram")).status).toBe(200);
  });
});

/**
 * The post-login redirect validator lives module-local inside the login page —
 * Next.js forbids extra exports from a page file — so it is loaded out of the
 * shipped source and executed here. If it is renamed or deleted, this fails
 * loudly rather than silently testing nothing.
 */
function loadSafeNextPath(): (next: string | null | undefined) => string {
  const file = path.join(process.cwd(), "src", "app", "login", "page.tsx");
  const src = readFileSync(file, "utf8");
  const def = /const DEFAULT_NEXT = "([^"]+)"/.exec(src);
  const start = src.indexOf("function safeNextPath(");
  if (!def || start === -1) {
    throw new Error("safeNextPath / DEFAULT_NEXT not found in src/app/login/page.tsx — the open-redirect guard moved or was removed");
  }
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  if (end === -1) throw new Error("could not delimit safeNextPath");
  const js = src.slice(start, end).replace(/^function safeNextPath\([^)]*\)\s*:\s*string\s*\{/, "function safeNextPath(next) {");
  const factory = new Function("DEFAULT_NEXT", `${js}\nreturn safeNextPath;`) as (d: string) => (n: string | null | undefined) => string;
  return factory(def[1]!);
}

describe("post-login redirect validator (open-redirect guard)", () => {
  const safeNextPath = loadSafeNextPath();

  it("is actually wired to the redirect the page performs", () => {
    const src = readFileSync(path.join(process.cwd(), "src", "app", "login", "page.tsx"), "utf8");
    expect(src).toMatch(/router\.push\(safeNextPath\(params\.get\("next"\)\)\)/);
  });

  it("keeps a plain in-app path", () => {
    expect(safeNextPath("/dashboard")).toBe("/dashboard");
    expect(safeNextPath("/leads?status=NEW#top")).toBe("/leads?status=NEW#top");
    expect(safeNextPath("  /automation  ")).toBe("/automation");
  });

  it("rejects an absolute URL to another origin", () => {
    for (const evil of ["https://evil.example/steal", "http://evil.example", "javascript:alert(1)", "data:text/html,x"]) {
      expect(safeNextPath(evil), evil).toBe("/dashboard");
    }
  });

  it("rejects protocol-relative and backslash forms browsers read as another origin", () => {
    for (const evil of ["//evil.example", "///evil.example", "/\\evil.example", "\\\\evil.example", "/\\/evil.example"]) {
      expect(safeNextPath(evil), evil).toBe("/dashboard");
    }
  });

  it("rejects control characters browsers strip before parsing (tab/newline smuggling)", () => {
    for (const evil of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/ x", "/x"]) {
      expect(safeNextPath(evil), JSON.stringify(evil)).toBe("/dashboard");
    }
  });

  it("falls back for anything missing or not a path", () => {
    expect(safeNextPath(null)).toBe("/dashboard");
    expect(safeNextPath(undefined)).toBe("/dashboard");
    expect(safeNextPath("")).toBe("/dashboard");
    expect(safeNextPath("dashboard")).toBe("/dashboard");
  });

  it("round-trips what the middleware actually puts in the query string", () => {
    const location = middleware(new NextRequest("http://localhost:3000/leads")).headers.get("location") ?? "";
    const next = new URL(location, "http://localhost:3000").searchParams.get("next");
    expect(next).toBe("/leads");
    expect(safeNextPath(next)).toBe("/leads");
  });
});

// ---------------------------------------------------------------------------
// 8. Secret storage
// ---------------------------------------------------------------------------

describe("AES-256-GCM secret storage", () => {
  it("round-trips, including unicode, single characters and long values", () => {
    for (const secret of ["IGQVJ-token", "salom dunyo — Ўзбек", "x".repeat(4096), "a"]) {
      const blob = encryptSecret(secret);
      // a one-character secret can appear in base64 by chance, so the
      // "plaintext is not in the blob" check only means something above that
      if (secret.length >= 8) expect(blob).not.toContain(secret);
      expect(decryptSecret(blob)).toBe(secret);
    }
  });

  /**
   * DEFECT (fixed): the length guard demanded 29 bytes, but iv(12)+tag(16) plus
   * an empty ciphertext is exactly 28 — so encryptSecret("") wrote a value that
   * decryptSecret then refused to read back.
   */
  it("round-trips the empty string too — an encrypt that cannot be decrypted is a data-loss bug", () => {
    const blob = encryptSecret("");
    expect(Buffer.from(blob, "base64")).toHaveLength(28);
    expect(decryptSecret(blob)).toBe("");
  });

  it("still refuses a blob too short to hold an iv and an auth tag", () => {
    for (const len of [0, 1, 12, 27]) {
      expect(() => decryptSecret(Buffer.alloc(len).toString("base64")), `len ${len}`).toThrow(/Corrupt/);
    }
    // 28 bytes of zeroes is the right SIZE but a forged tag — GCM must still reject it
    expect(() => decryptSecret(Buffer.alloc(28).toString("base64"))).toThrow();
  });

  it("produces a different ciphertext every time (random IV), so equal secrets are not detectable", () => {
    const blobs = new Set(Array.from({ length: 20 }, () => encryptSecret("same-token")));
    expect(blobs.size).toBe(20);
    for (const b of blobs) expect(decryptSecret(b)).toBe("same-token");
  });

  it("detects tampering anywhere in the blob — iv, auth tag or ciphertext", () => {
    const flipAt = (index: number) => {
      const raw = Buffer.from(encryptSecret("sensitive-token-value"), "base64");
      raw[index] = raw[index]! ^ 0xff;
      return raw.toString("base64");
    };
    expect(() => decryptSecret(flipAt(0))).toThrow(); // iv
    expect(() => decryptSecret(flipAt(20))).toThrow(); // auth tag
    expect(() => decryptSecret(flipAt(30))).toThrow(); // ciphertext
    expect(() => decryptSecret("not-base64-at-all")).toThrow();
    expect(() => decryptSecret("")).toThrow(/Corrupt/);
  });

  it("cannot be decrypted with a different key", () => {
    const blob = encryptSecret("cross-key-secret");
    const original = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = "b".repeat(64);
    _resetCoreEnvCache();
    try {
      expect(() => decryptSecret(blob)).toThrow();
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = original;
      _resetCoreEnvCache();
    }
  });
});

/**
 * A handful of guarantees this area depends on live in the schema rather than in
 * code — a mocked Prisma cannot enforce them, and a live database is the only
 * other witness. Asserting them against the schema file is the honest middle:
 * if someone drops the uniqueness or the index, this fails here instead of in
 * production.
 */
describe("schema guarantees the auth code relies on", () => {
  const schema = readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  const model = (name: string): string => {
    const m = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
    if (!m) throw new Error(`model ${name} not found in prisma/schema.prisma`);
    return m[1]!;
  };

  it("Session.tokenHash is unique — getAuth() looks a session up by it with findUnique", () => {
    expect(model("Session")).toMatch(/tokenHash\s+String\s+@unique/);
  });

  it("Admin.login is unique — the login route resolves an account by the normalized login", () => {
    expect(model("Admin")).toMatch(/login\s+String\s+@unique/);
  });

  it("AccountAccess is unique per (admin, account) — grantAccountAccess upserts on that key", () => {
    expect(model("AccountAccess")).toMatch(/@@unique\(\[adminId, accountId\]\)/);
  });

  it("AuditLog is indexed on (action, createdAt) — the lockout counter's exact lookup", () => {
    expect(model("AuditLog")).toMatch(/@@index\(\[action, createdAt\]\)/);
  });
});

describe("token hashing helpers", () => {
  it("hashSessionToken is deterministic, 64 hex chars, and peppered with SESSION_SECRET", () => {
    const token = randomToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(token)).not.toBe(hashSessionToken(`${token}x`));

    const original = process.env.SESSION_SECRET;
    const before = hashSessionToken(token);
    process.env.SESSION_SECRET = "a-completely-different-session-secret-value";
    _resetCoreEnvCache();
    try {
      expect(hashSessionToken(token)).not.toBe(before);
    } finally {
      process.env.SESSION_SECRET = original;
      _resetCoreEnvCache();
    }
    expect(hashSessionToken(token)).toBe(before);
  });

  it("safeEqual compares by value and refuses different lengths without throwing", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
