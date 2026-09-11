import { PrismaClient } from "@prisma/client";
async function main() {
  const prisma = new PrismaClient();
  const byStatus = await prisma.job.groupBy({ by: ["status", "type"], _count: true });
  console.log("jobs by status/type:", JSON.stringify(byStatus));
  const oldestPending = await prisma.job.findFirst({ where: { status: "PENDING" }, orderBy: { runAt: "asc" }, select: { type: true, runAt: true, attempts: true } });
  console.log("oldest pending:", JSON.stringify(oldestPending), oldestPending ? "age(s): " + Math.round((Date.now()-oldestPending.runAt.getTime())/1000) : "");
  await prisma.$disconnect();
}
main();
