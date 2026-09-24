import { AsyncLocalStorage } from "node:async_hooks";
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
  | "billing.retry"
  | "video.process";

/**
 * Execution lanes. A drain only claims lanes it can finish inside its own time
 * budget, so work is never killed half-done by a platform timeout:
 *   default — short jobs (seconds). Every drain claims these, including the
 *             60s serverless cron route.
 *   video   — FFmpeg renders and transcriptions (minutes). Only a resident
 *             worker process with ffmpeg available claims these.
 */
export type JobLane = "default" | "video";

export const JOB_LANES: readonly JobLane[] = ["default", "video"] as const;

/** Which lane each job type runs in. Unlisted types are "default". */
const LANE_BY_TYPE: Partial<Record<JobType, JobLane>> = {
  "video.process": "video",
};

export function laneForType(type: JobType | string): JobLane {
  return LANE_BY_TYPE[type as JobType] ?? "default";
}

/**
 * How long a claim stays valid before recovery may reclaim the job. The running
 * worker renews this (heartbeatJob) every HEARTBEAT_INTERVAL_MS, so the lease
 * only lapses when the process actually died — a job that legitimately takes
 * 20 minutes is never stolen and executed twice.
 */
const LEASE_MS_BY_LANE: Record<JobLane, number> = {
  default: 5 * 60_000,
  video: 10 * 60_000,
};

/**
 * Hard ceiling on one handler invocation. Without it a single hung socket
 * stalls a worker forever (no outbound fetch in this codebase sets its own
 * deadline). Video renders get their own, much larger budget.
 */
const TIMEOUT_MS_BY_LANE: Record<JobLane, number> = {
  default: 2 * 60_000,
  video: 60 * 60_000,
};

export function jobTimeoutMs(lane: JobLane): number {
  if (lane === "video") {
    const n = Number(process.env.VIDEO_JOB_TIMEOUT_MS);
    if (Number.isFinite(n) && n >= 60_000) return Math.min(n, 6 * 3600_000);
  }
  return TIMEOUT_MS_BY_LANE[lane];
}

/** Renew the lock this often while a handler runs. */
export const HEARTBEAT_INTERVAL_MS = 60_000;

export interface EnqueueOptions {
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
  /** Unique key — a second enqueue with the same key is a no-op. */
  idempotencyKey?: string;
  /** Override the lane derived from the job type (rarely needed). */
  lane?: JobLane;
}

export async function enqueue(type: JobType, payload: Record<string, unknown>, opts: EnqueueOptions = {}): Promise<Job | null> {
  try {
    const job = await prisma.job.create({
      data: {
        type,
        payload: payload as Prisma.InputJsonValue,
        lane: opts.lane ?? laneForType(type),
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

/**
 * Claim the next runnable job atomically, restricted to lanes this process can
 * actually finish. `attempts < maxAttempts` is filtered here too: a job that
 * exhausted its retries is never handed out again (previously a stale-recovered
 * job could loop forever, because only failJob ever checked the cap).
 */
export async function claimNextJob(workerId: string, lanes: readonly JobLane[] = ["default"]): Promise<Job | null> {
  const allowed = lanes.length > 0 ? [...lanes] : ["default"];
  const leaseMs = Math.max(...allowed.map((l) => LEASE_MS_BY_LANE[l as JobLane] ?? LEASE_MS_BY_LANE.default));
  const rows = await prisma.$queryRaw<Job[]>`
    UPDATE "Job"
    SET status = 'RUNNING', "lockedAt" = NOW(), "lockedBy" = ${workerId},
        "leaseExpiresAt" = NOW() + make_interval(secs => ${leaseMs / 1000}),
        attempts = attempts + 1, "updatedAt" = NOW()
    WHERE id = (
      SELECT id FROM "Job"
      WHERE status IN ('PENDING', 'FAILED')
        AND "runAt" <= NOW()
        AND lane = ANY(${allowed}::text[])
        AND attempts < "maxAttempts"
      ORDER BY priority DESC, "runAt" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *`;
  return rows[0] ?? null;
}

/**
 * Extend the lease of a job this worker still holds. Returns false when the
 * lock was lost (another worker recovered it), so the caller can abandon the
 * run instead of writing its result over someone else's.
 */
export async function heartbeatJob(jobId: string, workerId: string, lane: JobLane = "default"): Promise<boolean> {
  const leaseMs = LEASE_MS_BY_LANE[lane] ?? LEASE_MS_BY_LANE.default;
  const res = await prisma.job.updateMany({
    where: { id: jobId, lockedBy: workerId, status: "RUNNING" },
    data: { leaseExpiresAt: new Date(Date.now() + leaseMs) },
  });
  return res.count > 0;
}

/**
 * Terminal writes are conditional on this worker still holding the lock. A run
 * whose lease lapsed (the process stalled, recovery handed the job to someone
 * else) must not write its outcome over the worker that has it now — the same
 * reason heartbeatJob reports a lost lock. `false` = the write was dropped.
 */
export async function completeJob(jobId: string, owner?: string | null): Promise<boolean> {
  const res = await prisma.job.updateMany({
    where: { id: jobId, ...(owner ? { lockedBy: owner, status: "RUNNING" } : {}) },
    data: { status: "COMPLETED", lockedAt: null, lockedBy: null, leaseExpiresAt: null, lastError: null },
  });
  return res.count > 0;
}

export async function failJob(job: Job, err: unknown, owner?: string | null): Promise<boolean> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const dead = job.attempts >= job.maxAttempts;
  const res = await prisma.job.updateMany({
    where: { id: job.id, ...(owner ? { lockedBy: owner, status: "RUNNING" } : {}) },
    data: {
      status: dead ? "DEAD" : "FAILED",
      lastError: message.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      leaseExpiresAt: null,
      runAt: dead ? job.runAt : new Date(Date.now() + backoffMs(job.attempts)),
    },
  });
  if (res.count === 0) return false;
  (dead ? log.error : log.warn)("job failed", { jobId: job.id, type: job.type, attempt: job.attempts, dead, error: message });
  return true;
}

/**
 * Recover jobs whose worker died mid-run — the lease lapsed without a heartbeat.
 *
 * Two rules that used to be missing, and together made a killed job retry
 * forever at full speed: a recovered job that has exhausted its attempts is
 * DEAD (not FAILED), and a recovered job gets the same exponential backoff a
 * normally-failed job gets instead of being instantly claimable again. That
 * matters most in the video lane, where a render that reliably runs the host
 * out of memory would otherwise re-run in a tight loop forever.
 */
export async function recoverStaleJobs(): Promise<number> {
  const now = new Date();
  const stale = await prisma.job.findMany({
    where: {
      status: "RUNNING",
      OR: [
        { leaseExpiresAt: { lt: now } },
        // legacy rows claimed before leases existed
        { leaseExpiresAt: null, lockedAt: { lt: new Date(now.getTime() - 5 * 60_000) } },
      ],
    },
    select: { id: true, type: true, attempts: true, maxAttempts: true },
    take: 200,
  });
  if (stale.length === 0) return 0;

  let revived = 0;
  let dead = 0;
  for (const job of stale) {
    const exhausted = job.attempts >= job.maxAttempts;
    await prisma.job.update({
      where: { id: job.id },
      data: {
        status: exhausted ? "DEAD" : "FAILED",
        lockedAt: null,
        lockedBy: null,
        leaseExpiresAt: null,
        lastError: exhausted
          ? "worker lock expired and retries are exhausted — job dead-lettered"
          : "worker lock expired (the process died, or the handler outran its time budget and was abandoned)",
        ...(exhausted ? {} : { runAt: new Date(Date.now() + backoffMs(job.attempts)) }),
      },
    });
    if (exhausted) dead++;
    else revived++;
  }
  log.warn("recovered stale jobs", { revived, dead, types: [...new Set(stale.map((j) => j.type))] });
  return stale.length;
}

// ---- worker liveness ----

/**
 * Record that a drain is alive and which lanes it serves, so the platform can
 * tell "queue idle" from "nothing is draining the queue", and can say honestly
 * whether a video-capable worker exists before it accepts a render.
 */
export async function recordWorkerHeartbeat(input: {
  workerId: string;
  lanes: readonly JobLane[];
  ffmpeg?: boolean;
  kind?: "worker" | "cron" | "inline";
  jobsDone?: number;
}): Promise<void> {
  try {
    await prisma.workerHeartbeat.upsert({
      where: { id: input.workerId },
      create: {
        id: input.workerId,
        lanes: [...input.lanes],
        ffmpeg: input.ffmpeg ?? false,
        kind: input.kind ?? "worker",
        jobsDone: input.jobsDone ?? 0,
        lastSeenAt: new Date(),
      },
      update: {
        lanes: [...input.lanes],
        ffmpeg: input.ffmpeg ?? false,
        kind: input.kind ?? "worker",
        lastSeenAt: new Date(),
        ...(input.jobsDone !== undefined ? { jobsDone: { increment: input.jobsDone } } : {}),
      },
    });
  } catch (err) {
    // liveness bookkeeping must never break job processing
    log.warn("worker heartbeat failed", errorFields(err));
  }
}

/** Workers seen within `withinMs` (default 5 min), newest first. */
export async function liveWorkers(withinMs = 5 * 60_000) {
  return prisma.workerHeartbeat.findMany({
    where: { lastSeenAt: { gte: new Date(Date.now() - withinMs) } },
    orderBy: { lastSeenAt: "desc" },
  });
}

/** Is a process that can actually run FFmpeg work online right now? */
export async function isVideoWorkerOnline(withinMs = 5 * 60_000): Promise<boolean> {
  const n = await prisma.workerHeartbeat.count({
    where: { lastSeenAt: { gte: new Date(Date.now() - withinMs) }, ffmpeg: true, lanes: { has: "video" } },
  });
  return n > 0;
}

// ---- handler registry ----

export type JobHandler = (payload: Record<string, unknown>, job: Job, signal: AbortSignal) => Promise<void>;

const handlers = new Map<string, JobHandler>();

/**
 * The running job's abort signal, for work reached through a call chain that
 * does not thread one (queue/handlers.ts calls runPublishJob(id) and nothing
 * else). Aborted when the handler's time budget expires — the only way code
 * with side effects can learn that the queue has stopped waiting for it and
 * that this job is going to be run again.
 */
const jobContext = new AsyncLocalStorage<{ job: Job; signal: AbortSignal }>();

export function currentJobSignal(): AbortSignal | undefined {
  return jobContext.getStore()?.signal;
}

export function registerHandler(type: JobType, handler: JobHandler): void {
  handlers.set(type, handler);
}

export function getHandler(type: string): JobHandler | undefined {
  return handlers.get(type);
}

export class JobTimeoutError extends Error {
  constructor(ms: number) {
    super(`Handler exceeded its ${Math.round(ms / 1000)}s budget and was abandoned`);
    this.name = "JobTimeoutError";
  }
}

/**
 * Run one job with two protections the queue previously lacked:
 *
 *  - a hard timeout, so one hung socket cannot stall a worker forever; and
 *  - a lease heartbeat while the handler runs, so a legitimately long job
 *    (a video render) is not declared stale and executed a second time.
 *
 * The timeout can only abandon the await — nothing in JavaScript kills a promise
 * — so the handler keeps running with all of its side effects in flight. That is
 * why a timed-out job is NOT failed here: failing it releases the lock and puts
 * the job back a few seconds later, ON TOP of the pass still running, and for
 * publish.run that second pass can create a second Instagram media container and
 * post twice. Instead the job keeps the lease it already holds and the lease
 * simply stops being renewed, so no worker can claim it until the lease lapses
 * (recoverStaleJobs then retries it with backoff) — the first moment a retry is
 * known not to overlap. Handlers also get an AbortSignal, so a cooperative one
 * can stop at its next checkpoint instead of running on blind.
 */
export async function processJob(job: Job, workerId?: string): Promise<void> {
  const handler = handlers.get(job.type);
  if (!handler) {
    await failJob(job, new Error(`No handler registered for job type ${job.type}`));
    return;
  }

  const lane = (job.lane as JobLane) ?? laneForType(job.type);
  const budgetMs = jobTimeoutMs(lane);
  const owner = workerId ?? job.lockedBy ?? null;

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (owner) {
    heartbeat = setInterval(() => {
      void heartbeatJob(job.id, owner, lane).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    // never hold the process open just for a heartbeat
    heartbeat.unref?.();
  }
  const stopHeartbeat = () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  };

  const controller = new AbortController();
  // Identity, not `instanceof`: a handler that rejects in the same tick the timer
  // fires must still be treated as a handler failure, not as an abandoned pass.
  const expired = new JobTimeoutError(budgetMs);
  const running = jobContext.run({ job, signal: controller.signal }, async () =>
    handler((job.payload ?? {}) as Record<string, unknown>, job, controller.signal),
  );

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      running,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(expired), budgetMs);
        timer.unref?.();
      }),
    ]);
    await completeJob(job.id, owner);
  } catch (err) {
    if (err === expired) {
      controller.abort(expired);
      stopHeartbeat();
      watchAbandonedRun(job, owner, running, budgetMs);
      return;
    }
    await failJob(job, err, owner);
  } finally {
    if (timer) clearTimeout(timer);
    stopHeartbeat();
  }
}

/**
 * Keep listening to a handler the timeout walked away from: it still owns the
 * job's lease, so if it does come back its real outcome is the job's outcome.
 * The write is conditional on this worker still holding the lock, so a handler
 * that surfaces long after recovery gave the job to someone else changes nothing.
 */
function watchAbandonedRun(job: Job, owner: string | null, running: Promise<void>, budgetMs: number): void {
  log.error("handler exceeded its budget — job left on its lease instead of being retried underneath it", {
    jobId: job.id,
    type: job.type,
    attempt: job.attempts,
    budgetMs,
  });
  void running
    .then(
      async () => {
        const recorded = await completeJob(job.id, owner);
        log.warn("abandoned handler finished after the budget", { jobId: job.id, type: job.type, recorded });
      },
      async (err) => {
        await failJob(job, err, owner);
      },
    )
    .catch((err) => log.error("could not record an abandoned handler's outcome", { jobId: job.id, ...errorFields(err) }));
}

/**
 * Drain runnable jobs until the queue is empty (worker loop body / inline mode).
 * `lanes` defaults to the short lane only: a caller must opt in to the video
 * lane by proving it can run FFmpeg, so a serverless drain never claims a
 * render it would be killed halfway through.
 */
export async function drainOnce(workerId: string, max = 25, lanes: readonly JobLane[] = ["default"]): Promise<number> {
  let processed = 0;
  for (let i = 0; i < max; i++) {
    const job = await claimNextJob(workerId, lanes);
    if (!job) break;
    await processJob(job, workerId);
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
