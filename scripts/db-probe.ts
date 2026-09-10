import { PrismaClient } from "@prisma/client";

/**
 * Connectivity probe for a remote database. Prints the server version and the
 * tables that already exist, so a hosted setup can be verified before seeding.
 * Reads DATABASE_URL from the environment — never hard-code a connection string.
 */

const prisma = new PrismaClient();

async function main() {
  const version = await prisma.$queryRaw<Array<{ version: string }>>`SELECT version()`;
  console.log("Connected:", version[0]?.version.split(",")[0]);

  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name`;
  console.log(`Tables present: ${tables.length}`);
  if (tables.length > 0) console.log("  " + tables.map((t) => t.table_name).join(", "));
}

main()
  .catch((e: unknown) => {
    console.error("FAILED:", e instanceof Error ? e.message.split("\n")[0] : String(e));
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
