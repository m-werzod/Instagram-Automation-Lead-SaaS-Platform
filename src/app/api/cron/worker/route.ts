import { NextRequest, NextResponse } from "next/server";
import { claimNextJob, processJob, recoverStaleJobs, queueDepth, recordWorkerHeartbeat } from "@/lib/queue";
import { ensurePeriodicJobs } from "@/lib/queue/handlers";
import { safeEqual } from "@/lib/crypto";
import { createLogger, errorFields } from "@/lib/logger";

/**
 * Serverless replacement for the long-running worker (scripts/worker.ts).
 *
 * Vercel and similar platforms cannot host a permanent polling process, so a
 * scheduler calls this endpoint instead; it drains the job queue for as long as
 * the invocation is allowed to run, then returns.
 *
 * Trigger it with Vercel Cron, GitHub Actions, or any external scheduler:
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/cron/worker
 *
 * When you run the dedicated worker process instead (a VPS, Railway, Render),
 * this endpoint is harmless: both claim jobs with FOR UPDATE SKIP LOCKED, so
 * they never process the same job twice.
 */

export const dynamic = "force-dynamic";
/** Pro/Enterprise allow up to 300s; Hobby caps this lower automatically. */
export const maxDuration = 60;

const log = createLogger("cron.worker");

/** Stop claiming new jobs this long before the invocation limit. */
const SAFETY_MARGIN_MS = 8_000;
const HARD_BUDGET_MS = maxDuration * 1000 - SAFETY_MARGIN_MS;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  // Without a configured secret the endpoint stays closed — never open by default.
  if (!secret) return false;

  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (bearer && safeEqual(bearer, secret)) return true;

  // Allow ?secret= for schedulers that cannot set headers.
  const query = req.nextUrl.searchParams.get("secret");
  return Boolean(query && safeEqual(query, secret));
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or missing cron secret",
          fix: "Set CRON_SECRET in the environment and send it as 'Authorization: Bearer <secret>'.",
        },
      },
      { status: 401 },
    );
  }

  const startedAt = Date.now();
  const workerId = `cron-${startedAt}`;
  let processed = 0;
  let failed = 0;

  try {
    await recoverStaleJobs();
    await ensurePeriodicJobs();
    // Serverless: this drain can only ever serve the short lane. Video renders
    // stay queued for a resident worker instead of being killed at 60s.
    await recordWorkerHeartbeat({ workerId, lanes: ["default"], ffmpeg: false, kind: "cron" });

    while (Date.now() - startedAt < HARD_BUDGET_MS) {
      const job = await claimNextJob(workerId, ["default"]);
      if (!job) break; // queue drained
      try {
        await processJob(job, workerId);
      } catch (err) {
        failed++;
        log.error("job crashed inside cron drain", { jobId: job.id, ...errorFields(err) });
      }
      processed++;
    }

    const depth = await queueDepth();
    log.info("cron drain finished", { processed, failed, ms: Date.now() - startedAt, pending: depth.pending });

    return NextResponse.json({
      ok: true,
      data: {
        processed,
        failed,
        durationMs: Date.now() - startedAt,
        remaining: depth,
        // true when the budget ran out with work still queued — schedule more often
        truncated: depth.pending > 0 && Date.now() - startedAt >= HARD_BUDGET_MS,
      },
    });
  } catch (err) {
    log.error("cron drain failed", errorFields(err));
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "Queue drain failed", reason: String(err).slice(0, 200) } },
      { status: 500 },
    );
  }
}
