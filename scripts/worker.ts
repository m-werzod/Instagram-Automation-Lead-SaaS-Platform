import "dotenv/config";
import os from "os";
import { drainOnce, recoverStaleJobs, recordWorkerHeartbeat, type JobLane } from "@/lib/queue";
import { ffmpegAvailability } from "@/lib/video/ffmpeg";
import { ensurePeriodicJobs } from "@/lib/queue/handlers";
import { createLogger, errorFields } from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/**
 * Standalone worker process:  npm run worker
 * Polls the DB-backed queue, recovers stale locks, seeds periodic jobs.
 * Run exactly one or more instances — claiming uses FOR UPDATE SKIP LOCKED,
 * so multiple workers are safe.
 */

const log = createLogger("worker");
const workerId = process.env.WORKER_ID || `${os.hostname()}-${process.pid}`;
const pollMs = Math.max(250, Number(process.env.WORKER_POLL_MS ?? 1000));

let running = true;

async function main() {
  log.info("worker starting", { workerId, pollMs });
  // verify DB before looping
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    log.error("cannot reach database — is DATABASE_URL correct and migrated?", errorFields(err));
    process.exit(1);
  }

  /**
   * Lane selection. The video lane carries minutes-long FFmpeg renders, so this
   * process only claims it when FFmpeg actually runs here. A worker without
   * FFmpeg keeps serving the default lane instead of failing every render it
   * grabs, and the platform reports the video lane as offline rather than
   * letting projects queue against nothing.
   */
  const ff = await ffmpegAvailability(true);
  const videoEnabled = ff.available && process.env.VIDEO_WORKER !== "false";
  const lanes: JobLane[] = videoEnabled ? ["default", "video"] : ["default"];
  if (ff.available) {
    log.info("video lane enabled", { ffmpeg: ff.ffmpegVersion, ffprobe: ff.ffprobeVersion, enabled: videoEnabled });
  } else {
    log.warn("video lane disabled — FFmpeg is not available on this host", { reason: ff.reason });
  }

  let lastMaintenance = 0;
  let lastHeartbeat = 0;
  let doneSinceHeartbeat = 0;
  while (running) {
    try {
      const now = Date.now();
      if (now - lastMaintenance > 60_000) {
        lastMaintenance = now;
        await recoverStaleJobs();
        await ensurePeriodicJobs();
      }
      if (now - lastHeartbeat > 30_000) {
        lastHeartbeat = now;
        await recordWorkerHeartbeat({ workerId, lanes, ffmpeg: videoEnabled, kind: "worker", jobsDone: doneSinceHeartbeat });
        doneSinceHeartbeat = 0;
      }
      const processed = await drainOnce(workerId, 20, lanes);
      doneSinceHeartbeat += processed;
      if (processed === 0) {
        await sleep(pollMs);
      }
    } catch (err) {
      log.error("worker loop error", errorFields(err));
      await sleep(Math.max(pollMs, 3000));
    }
  }
  log.info("worker stopped", { workerId });
  await prisma.$disconnect();
  process.exit(0);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

process.on("SIGINT", () => {
  log.info("SIGINT — finishing current job then exiting");
  running = false;
});
process.on("SIGTERM", () => {
  running = false;
});

// register all job handlers, then start
import("@/lib/queue/handlers").then(main);
