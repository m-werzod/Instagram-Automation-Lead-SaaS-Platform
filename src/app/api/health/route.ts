import { prisma } from "@/lib/prisma";
import { route, ok } from "@/lib/api";
import { queueDepth, liveWorkers, isVideoWorkerOnline } from "@/lib/queue";
import { isEmailConfigured, isMetaConfigured } from "@/lib/env";
import { EMAIL_NOT_CONFIGURED_PREFIX } from "@/lib/email";
import { aiRuntimeInfo } from "@/lib/ai";
import { rateLimiterInfo } from "@/lib/rate-limit";
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

  const [queue, failedEmailsTotal, unsendableEmails, deadJobs, tokenIssues, lastWebhook, workers, videoWorker] =
    await Promise.all([
      dbOk ? queueDepth() : Promise.resolve(null),
      dbOk ? prisma.emailEvent.count({ where: { status: "FAILED" } }) : Promise.resolve(0),
      dbOk
        ? prisma.emailEvent.count({ where: { status: "FAILED", lastError: { startsWith: EMAIL_NOT_CONFIGURED_PREFIX } } })
        : Promise.resolve(0),
      dbOk ? prisma.job.count({ where: { status: "DEAD" } }) : Promise.resolve(0),
      dbOk
        ? prisma.instagramToken.count({ where: { status: { in: ["EXPIRED", "REVOKED"] }, account: { status: { not: "DISCONNECTED" } } } })
        : Promise.resolve(0),
      dbOk ? prisma.webhookEvent.findFirst({ orderBy: { receivedAt: "desc" }, select: { receivedAt: true, status: true } }) : Promise.resolve(null),
      dbOk ? liveWorkers() : Promise.resolve([]),
      dbOk ? isVideoWorkerOnline() : Promise.resolve(false),
    ]);

  const emailConfigured = isEmailConfigured();
  // Notifications that were never attempted because SMTP is switched off are
  // not delivery failures; counting them as such reports a healthy install as
  // broken and buries genuine SMTP errors.
  const failedEmails = Math.max(0, failedEmailsTotal - unsendableEmails);

  const drainOnline = workers.length > 0;
  const backlogUnattended = Boolean(queue && queue.pending > 0 && !drainOnline);

  return ok({
    status: dbOk ? "ok" : "degraded",
    components: {
      database: { healthy: dbOk, latencyMs: dbLatencyMs },
      queue: queue
        ? {
            // An empty queue proves nothing on its own — it looks identical
            // whether the drain is keeping up or was never started.
            healthy: queue.dead === 0 && !backlogUnattended,
            ...queue,
            drainOnline,
            backlogUnattended,
            workers: workers.map((w) => ({
              id: w.id,
              kind: w.kind,
              lanes: w.lanes,
              ffmpeg: w.ffmpeg,
              lastSeenAt: w.lastSeenAt,
              jobsDone: w.jobsDone,
            })),
            videoWorkerOnline: videoWorker,
          }
        : { healthy: false, drainOnline: false, backlogUnattended: false, workers: [], videoWorkerOnline: false },
      email: {
        configured: emailConfigured,
        // An optional feature that was never switched on is not a fault; only a
        // configured mailer that keeps failing is.
        healthy: emailConfigured ? failedEmails === 0 : true,
        failedCount: failedEmails,
        notSentCount: unsendableEmails,
      },
      meta: { configured: isMetaConfigured(), tokenIssues },
      ai: aiRuntimeInfo(),
      webhooks: { lastEventAt: lastWebhook?.receivedAt ?? null, lastStatus: lastWebhook?.status ?? null },
      rateLimiter: rateLimiterInfo(),
      worker: {
        note: deadJobs > 0
          ? `${deadJobs} dead jobs need attention`
          : drainOnline
            ? `${workers.length} worker(s) reporting in${videoWorker ? "" : " — none can render video (FFmpeg)"}`
            : "no worker has reported in for 5 minutes — run `npm run worker`, schedule /api/cron/worker, or set QUEUE_INLINE=true in dev",
        deadJobs,
      },
    },
  });
});
