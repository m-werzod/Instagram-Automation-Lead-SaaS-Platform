import { PrismaClient } from "@prisma/client";
async function main() {
  const prisma = new PrismaClient();
  const lead = await prisma.lead.findFirst({ where: { name: "Bekzod Telegram-Live-Test" }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true } });
  if (!lead) { console.log("LEAD_NOT_FOUND"); await prisma.$disconnect(); return; }
  const events = await prisma.leadEvent.findMany({ where: { leadId: lead.id }, select: { type: true, data: true } });
  const jobs = await prisma.job.findMany({ where: { type: "telegram.send", payload: { path: ["leadId"], equals: lead.id } }, select: { status: true, attempts: true, lastError: true, runAt: true } });
  const allTgJobs = await prisma.job.findMany({ where: { type: "telegram.send" }, orderBy: { createdAt: "desc" }, take: 3, select: { status: true, attempts: true, lastError: true } });
  console.log("lead age(s):", Math.round((Date.now() - lead.createdAt.getTime())/1000));
  console.log("events:", JSON.stringify(events.map(e => e.type)));
  console.log("this lead tg job:", JSON.stringify(jobs));
  console.log("recent tg jobs:", JSON.stringify(allTgJobs));
  await prisma.$disconnect();
}
main();
