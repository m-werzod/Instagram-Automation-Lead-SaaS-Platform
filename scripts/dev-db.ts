import "dotenv/config";
import EmbeddedPostgres from "embedded-postgres";
import path from "path";

/**
 * Zero-setup local development database:  npm run db:dev
 * Boots an embedded PostgreSQL 17 on port 5433 with data in ./.pgdata
 * (gitignored). For production use a real/managed PostgreSQL instead — see
 * docs/DEPLOYMENT.md.
 *
 * Matching DATABASE_URL:
 *   postgresql://postgres:postgres@localhost:5433/ig_automation
 */

const DATA_DIR = path.resolve(".pgdata");
const PORT = 5433;

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres",
    port: PORT,
    persistent: true,
    // Force UTF-8 — Windows initdb otherwise picks the ANSI codepage (e.g.
    // WIN1251), which cannot store emoji found in Instagram captions.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
  });

  const isNew = !(await import("fs")).existsSync(path.join(DATA_DIR, "PG_VERSION"));
  if (isNew) {
    console.log("Initialising embedded PostgreSQL cluster (first run)…");
    await pg.initialise();
  }
  await pg.start();
  if (isNew) {
    await pg.createDatabase("ig_automation");
  }
  console.log("");
  console.log("✔ Embedded PostgreSQL running");
  console.log(`  DATABASE_URL=postgresql://postgres:postgres@localhost:${PORT}/ig_automation`);
  console.log("  Keep this terminal open. Ctrl+C stops the database.");

  const stop = async () => {
    console.log("\nStopping embedded PostgreSQL…");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("Failed to start embedded PostgreSQL:", err);
  process.exit(1);
});
