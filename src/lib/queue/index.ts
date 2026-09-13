import type { Job, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createLogger, errorFields } from "@/lib/logger";

const log = createLogger("queue");

/**
 * DB-backed job queue (Postgres FOR UPDATE SKIP LOCKED).
 * Chosen over Redis/BullMQ deliberately for this deployment size — see
 * DEVELOPMENT_PLAN.md §3. The public surface (enqueue + handler registry)
 * is driver-agnostic so a Redis driver can replace the internals later.
 *
 * Retry policy: exponential backoff with jitter — 30s, 2m, 8m, 32m … capped
 * at 2h. Jobs move to DEAD after maxAttempts.
 */

export type JobType =
  | "webhook.process"
  | "ai.reply"
  | "comment.ai_reply"
  | "lead.process"
  | "email.send"
  | "telegram.send"
  | "leadgen.fetch"
  | "tokens.refresh"
  | "analytics.sync"
  | "queue.cleanup"
  | "publish.run"
  | "campaigns.sync"
  | "billing.schedules"
  | "billing.retry";

export interface EnqueueOptions {
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  /** Unique key — a second enqueue with the same key is a no-op. */
  idempotencyKey?: string;
}

export async function enqueue(type: JobType, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<Job | null> {
  try {
    const job = await prisma.job.create({
      data: {
        type,
        payload: payload as Prisma.InputJsonValue,
        runAt: opts.runAt ?? new Date(),
        priority: opts.priority ?? 0,
        maxAttempts: opts.maxAttempts ?? 5,
        idempotencyKey: opts.idempotencyKey,
      },
    });
    kickInlineWorker();
    return job;
  } catch (err) {
    // unique violation on idempotencyKey = already enqueued → fine
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "P2002") {
      return null;
    }
    throw err;
  }
}

export function backoffMs(attempt: number): number {
  const base = 30_000 * Math.pow(4, Math.max(0, attempt - 1)); // 30s, 2m, 8m, 32m
  const capped = Math.min(base, 2 * 3600_000);
  return capped + Math.floor(Math.random() * 5_000);
}

/** Claim the next runnable job atomically. */
export async function claimNextJob(workerId: string): Promise<Job | null> {
  const rows = await prisma.$queryRaw<Job[]>`
    UPDATE "Job"
    SET status = 'RUNNING', "lockedAt" = NOW(), "lockedBy" = ${workerId},
        attempts = attempts + 1, "updatedAt" = NOW()
    WHERE id = (
      SELECT id FROM "Job"
      WHERE status IN ('PENDING', 'FAILED') AND "runAt" <= NOW()
      ORDER BY priority DESC, "runAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *`;
  return rows[0] ?? null;
}

export async function completeJob(jobId: string): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { status: "COMPLETED", lockedAt: null, lockedBy: null, lastError: null },
  });
}

export async function failJob(job: Job, err: unknown): Promise<void> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const dead = job.attempts >= job.maxAttempts;
  await prisma.job.update({
    where: { id: job.id },
    data: {
      status: dead ? "DEAD" : "FAILED",
      lastError: message.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      runAt: dead ? job.runAt : new Date(Date.now() + backoffMs(job.attempts)),
    },
  });
  (dead ? log.error : log.warn)("job failed", { jobId: job.id, type: job.type, attempt: job.attempts, dead, error: message });
}

/** Recover jobs whose worker died mid-run (lock older than 5 minutes). */
export async function recoverStaleJobs(): Promise<number> {
  const res = await prisma.job.updateMany({
    where: { status: "RUNNING", lockedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
    data: { status: "FAILED", lockedAt: null, lockedBy: null, lastError: "worker lock expired" },
  });
  if (res.count > 0) log.warn("recovered stale jobs", { count: res.count });
  return res.count;
}

// ---- handler registry ----

export type JobHandler = (payload: Record<string, unknown>, job: Job) => Promise<void>;

const handlers = new Map<string, JobHandler>();

export function registerHandler(type: JobType, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

export async function processJob(job: Job): Promise<void> {
  const handler = handlers.get(job.type);
  if (!handler) {
    await failJob(job, new Error(`No handler registered for job type ${job.type}`));
    return;
  }
  try {
    await handler((job.payload ?? {}) as Record<string, unknown>, job);
    await completeJob(job.id);
  } catch (err) {
    await failJob(job, err);
  }
}

/** Drain runnable jobs until the queue is empty (worker loop body / inline mode). */
export async function drainOnce(workerId: string, max = 25): Promise<number> {
  let processed = 0;
  for (let i = 0; i < max; i++) {
    const job = await claimNextJob(workerId);
    if (!job) break;
    await processJob(job);
    processed++;
  }
  return processed;
}

/**
 * Drain the queue immediately from a web request, using Next's `after()` so it
 * runs AFTER the response is sent (Vercel keeps the function alive for it). This
 * gives near-instant lead → Telegram delivery instead of waiting for the 5-min
 * cron, while the cron remains the reliability backstop. Never throws.
 *
 * One drain cascades: processing webhook.process enqueues lead.process, which
 * this same loop then claims (drainOnce re-queries until empty or `max`).
 */
export async function drainNow(max = 25): Promise<void> {
  try {
    await import("./handlers"); // ensure handlers are registered in this process
    await drainOnce(`after-${process.pid}-${Date.now()}`, max);
  } catch (err) {
    log.error("after() queue drain failed", errorFields(err));
  }
}

// ---- inline mode (dev convenience: process jobs in the web process) ----

let inlineRunning = false;

function kickInlineWorker(): void {
  if (process.env.QUEUE_INLINE !== "true" || inlineRunning) return;
  inlineRunning = true;
  setImmediate(async () => {
    try {
      // handlers must be registered in this process too
      await import("./handlers");
      await drainOnce(`inline-${process.pid}`);
    } catch (err) {
      log.error("inline queue drain failed", errorFields(err));
    } finally {
      inlineRunning = false;
    }
  });
}

export async function queueDepth(): Promise<{ pending: number; failed: number; dead: number; oldestPendingAgeSec: number | null }> {
  const [pending, failed, dead, oldest] = await Promise.all([
    prisma.job.count({ where: { status: "PENDING" } }),
    prisma.job.count({ where: { status: "FAILED" } }),
    prisma.job.count({ where: { status: "DEAD" } }),
    prisma.job.findFirst({ where: { status: "PENDING" }, orderBy: { runAt: "asc" }, select: { runAt: true } }),
  ]);
  return {
    pending,
    failed,
    dead,
    oldestPendingAgeSec: oldest ? Math.max(0, Math.floor((Date.now() - oldest.runAt.getTime()) / 1000)) : null,
  };
}
