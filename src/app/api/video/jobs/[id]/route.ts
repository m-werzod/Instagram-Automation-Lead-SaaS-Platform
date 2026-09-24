import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { cancelVideoJob } from "@/lib/video/jobs";

export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await requireAdmin();
  const { id } = await ctx.params;
  const job = await prisma.videoJob.findFirst({
    where: { id, ...(await accountScope(auth)) },
    include: { outputAsset: { select: { id: true, role: true, filename: true, sizeBytes: true, durationSec: true, width: true, height: true } } },
  });
  if (!job) throw notFound("Video job");
  return ok({ job });
});

/**
 * Cancel a queued or running job. A render already in flight notices within a
 * few seconds and its output is discarded rather than stored, so cancelling
 * cannot leave a half-finished export behind.
 */
export const DELETE = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;

  const job = await prisma.videoJob.findFirst({
    where: { id, ...(await accountScope(auth)) },
    select: { id: true, status: true, kind: true },
  });
  if (!job) throw notFound("Video job");

  const cancelled = await cancelVideoJob(job.id);
  if (!cancelled) {
    throw validationError(`This job has already finished (${job.status.toLowerCase()}) and cannot be cancelled.`);
  }

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CANCELLED_VIDEO_JOB,
    resourceType: "VideoJob",
    resourceId: job.id,
    before: { status: job.status, kind: job.kind },
    ip: clientIp(req),
  });

  return ok({ cancelled: true });
});
