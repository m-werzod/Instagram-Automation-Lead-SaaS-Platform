import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { queueDepth } from "@/lib/queue";
import { isEmailConfigured, isMetaConfigured, aiKeyFor, defaultAiProvider } from "@/lib/env";
import { getAuth } from "@/lib/auth/session";

/**
 * Health/observability endpoint (spec §38). Unauthenticated callers get a
 * bare liveness bit; admins get the full component matrix.
 */
export const GET = route(async () => {
  let dbOk = false;
  let dbLatencyMs: number | null = null;
  try {
    const t = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    dbLatencyMs = Date.now() - t;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  const auth = await getAuth().catch(() => null);
  if (!auth) return ok({ status: dbOk ? "ok" : "degraded" });

  const [queue, failedEmails, deadJobs, tokenIssues, lastWebhook] = await Promise.all([
    dbOk ? queueDepth() : Promise.resolve(null),
    dbOk ? prisma.emailEvent.count({ where: { status: "FAILED" } }) : Promise.resolve(0),
    dbOk ? prisma.job.count({ where: { status: "DEAD" } }) : Promise.resolve(0),
    dbOk
      ? prisma.instagramToken.count({ where: { status: { in: ["EXPIRED", "REVOKED"] }, account: { status: { not: "DISCONNECTED" } } } })
      : Promise.resolve(0),
    dbOk ? prisma.webhookEvent.findFirst({ orderBy: { receivedAt: "desc" }, select: { receivedAt: true, status: true } }) : Promise.resolve(null),
  ]);

  return ok({
    status: dbOk ? "ok" : "degraded",
    components: {
      database: { healthy: dbOk, latencyMs: dbLatencyMs },
      queue: queue
        ? { healthy: queue.dead === 0, ...queue }
        : { healthy: false },
      email: { configured: isEmailConfigured(), failedCount: failedEmails },
      meta: { configured: isMetaConfigured(), tokenIssues },
      ai: { provider: defaultAiProvider(), configured: aiKeyFor(defaultAiProvider()) !== null },
      webhooks: { lastEventAt: lastWebhook?.receivedAt ?? null, lastStatus: lastWebhook?.status ?? null },
      worker: {
        note: deadJobs > 0 ? `${deadJobs} dead jobs need attention` : "run `npm run worker` (or QUEUE_INLINE=true in dev)",
        deadJobs,
      },
    },
  });
});
