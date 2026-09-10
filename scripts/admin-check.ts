import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

/**
 * Diagnostic / recovery helper for admin sign-in.
 *
 *   npm run admin:check                 → list admins, show which DB they came from
 *   npm run admin:check -- <password>   → also test that password against each admin
 *
 * Use this when a login is rejected and you need to know whether the problem is
 * the credentials, the database connection, or a missing seed.
 */

const prisma = new PrismaClient();
const probe = process.argv[2] ?? process.env.ADMIN_PASSWORD ?? null;

async function main() {
  const url = process.env.DATABASE_URL ?? "(unset)";
  console.log("Database   :", url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@"));
  console.log("ADMIN_LOGIN:", process.env.ADMIN_LOGIN ?? "(unset — seed default is 'admin')");
  console.log("");

  const admins = await prisma.admin.findMany({
    select: { login: true, name: true, email: true, role: true, isActive: true, passwordHash: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (admins.length === 0) {
    console.log("No admin accounts exist in this database.");
    console.log("Fix: run `npm run db:seed` (uses ADMIN_LOGIN / ADMIN_PASSWORD from .env).");
    return;
  }

  console.log(`${admins.length} admin account(s):\n`);
  for (const a of admins) {
    console.log(`  Login   : ${a.login}${a.isActive ? "" : "   [DISABLED — cannot sign in]"}`);
    console.log(`  Name    : ${a.name}`);
    console.log(`  Role    : ${a.role}`);
    console.log(`  Email   : ${a.email ?? "(none)"}`);
    if (probe) {
      const ok = await bcrypt.compare(probe, a.passwordHash);
      console.log(`  Password: ${ok ? "MATCHES the password you supplied" : "does NOT match the password you supplied"}`);
    }
    console.log("");
  }

  console.log("Sign in with the Login value above (case-insensitive) — not an email address.");
  console.log("To reset a password: set ADMIN_LOGIN/ADMIN_PASSWORD in .env and run `npm run db:seed`.");
}

main()
  .catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    console.error("\nCould not read the database:", message.split("\n")[0]);
    console.error("\nMost common cause: the database is not running.");
    console.error("Fix: start it first with `npm run db:dev` (in a normal, non-Administrator terminal),");
    console.error("then re-run this command.");
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
