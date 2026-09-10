import { execSync } from "node:child_process";

/**
 * Build entry point for hosted deployments (Vercel etc.).
 *
 * Migrations only run when a database is actually configured. Running them
 * unconditionally makes the whole deployment fail with a Prisma stack trace
 * when DATABASE_URL is missing — which hides the real problem. Instead the
 * build succeeds and the app shows its "setup required" screen, which names
 * exactly what to set.
 */

function run(command) {
  console.log(`\n$ ${command}`);
  execSync(command, { stdio: "inherit" });
}

run("prisma generate");

const databaseUrl = process.env.DATABASE_URL?.trim();
if (databaseUrl) {
  try {
    run("prisma migrate deploy");
  } catch {
    console.error(
      "\n✖ Database migrations failed.\n" +
        "  The site will still deploy, but it cannot work until this is fixed.\n" +
        "  Check that DATABASE_URL is reachable from the build environment and that\n" +
        "  it points at a PostgreSQL database you own.\n",
    );
    // Deliberately not fatal: a deployed app that explains the problem beats a
    // failed build for anyone who has not configured the database yet.
  }
} else {
  console.warn(
    "\n⚠ DATABASE_URL is not set — skipping migrations.\n" +
      "  The site will deploy but nobody can sign in until you add DATABASE_URL\n" +
      "  (plus APP_URL, SESSION_SECRET and TOKEN_ENCRYPTION_KEY) and redeploy.\n" +
      "  See docs/DEPLOYMENT.md §9.\n",
  );
}

run("next build");
