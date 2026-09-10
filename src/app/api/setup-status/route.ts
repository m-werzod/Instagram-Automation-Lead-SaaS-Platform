import { NextResponse } from "next/server";

/**
 * Public, dependency-free readiness probe.
 *
 * Deliberately does NOT use coreEnv() or Prisma: it has to keep working on an
 * installation whose environment is broken, which is exactly when it matters.
 * Returns only which variable NAMES are missing — never a value, and never a
 * hint about a value that is present.
 */

export const dynamic = "force-dynamic";

interface Check {
  name: string;
  ok: boolean;
  problem?: string;
}

function checkCore(): Check[] {
  const appUrl = process.env.APP_URL?.trim();
  let appUrlOk = false;
  if (appUrl) {
    try {
      const u = new URL(appUrl);
      appUrlOk = u.protocol === "http:" || u.protocol === "https:";
    } catch {
      appUrlOk = false;
    }
  }

  const dbUrl = process.env.DATABASE_URL?.trim();
  const session = process.env.SESSION_SECRET ?? "";
  const tokenKey = process.env.TOKEN_ENCRYPTION_KEY ?? "";

  return [
    {
      name: "APP_URL",
      ok: appUrlOk,
      problem: appUrlOk ? undefined : "Must be the full public address of this site, e.g. https://your-app.vercel.app",
    },
    {
      name: "DATABASE_URL",
      ok: Boolean(dbUrl),
      problem: dbUrl ? undefined : "PostgreSQL connection string. Create a database first (Neon, Supabase or Vercel Postgres).",
    },
    {
      name: "SESSION_SECRET",
      ok: session.length >= 32,
      problem: session.length >= 32 ? undefined : "A random string of at least 32 characters.",
    },
    {
      name: "TOKEN_ENCRYPTION_KEY",
      ok: /^[0-9a-fA-F]{64}$/.test(tokenKey),
      problem: /^[0-9a-fA-F]{64}$/.test(tokenKey) ? undefined : "Exactly 64 hexadecimal characters (32 bytes).",
    },
  ];
}

export async function GET() {
  const checks = checkCore();
  const missing = checks.filter((c) => !c.ok);

  return NextResponse.json(
    {
      ok: true,
      data: {
        configured: missing.length === 0,
        missing,
        // Helps the operator confirm they are looking at the right deployment.
        host: process.env.VERCEL_URL ?? null,
        platform: process.env.VERCEL ? "vercel" : "self-hosted",
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
