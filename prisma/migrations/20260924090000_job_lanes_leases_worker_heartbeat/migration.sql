-- Job execution lanes + lock leases, and worker liveness.
--
-- lane: "default" jobs are short enough for the 60s serverless cron drain;
-- "video" jobs are minutes-long FFmpeg renders only a resident worker claims.
-- leaseExpiresAt: renewed while a job runs, so stale-recovery can no longer
-- steal a job that is legitimately still running (and re-run its side effects).

ALTER TABLE "Job" ADD COLUMN "lane" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Job" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

-- Existing RUNNING rows have no lease; give them the historic 5-minute one so
-- recovery keeps working across the deploy instead of reclaiming them at once.
UPDATE "Job" SET "leaseExpiresAt" = "lockedAt" + INTERVAL '5 minutes'
 WHERE "status" = 'RUNNING' AND "lockedAt" IS NOT NULL;

CREATE INDEX "Job_status_lane_runAt_priority_idx" ON "Job"("status", "lane", "runAt", "priority");
CREATE INDEX "Job_status_leaseExpiresAt_idx" ON "Job"("status", "leaseExpiresAt");

CREATE TABLE "WorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "lanes" TEXT[],
    "ffmpeg" BOOLEAN NOT NULL DEFAULT false,
    "kind" TEXT NOT NULL DEFAULT 'worker',
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jobsDone" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WorkerHeartbeat_lastSeenAt_idx" ON "WorkerHeartbeat"("lastSeenAt");
