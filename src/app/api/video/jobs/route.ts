import { NextRequest, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, parseBody, clientIp, enforceRateLimit } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError, AppError } from "@/lib/errors";
import { drainNow } from "@/lib/queue";
import { createLogger, errorFields } from "@/lib/logger";
import { editParamsSchema } from "@/lib/video/params";
import { enqueueVideoJob, reconcileStalledVideoJobs } from "@/lib/video/jobs";
import { videoCapabilities } from "@/lib/video/service";

/**
 * Starting and watching video work.
 *
 * A render is refused up front when nothing can run it: queueing a job against
 * an offline worker would leave an operator watching a progress bar that never
 * moves. The check names the missing dependency and how to fix it.
 */

const log = createLogger("api.video.jobs");

/** Throttle for the stalled-job sweep below; per process, which is enough. */
const RECONCILE_EVERY_MS = 60_000;
let lastReconcileAt = 0;

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) throw validationError("projectId is required");

  const project = await prisma.videoProject.findFirst({
    where: { id: projectId, ...(await accountScope(auth)) },
    select: { id: true },
  });
  if (!project) throw notFound("Video project");

  const jobs = await prisma.videoJob.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "desc" },
    take: 25,
    select: {
      id: true, kind: true, status: true, progressPct: true, error: true, logTail: true,
      outputAssetId: true, startedAt: true, finishedAt: true, createdAt: true,
    },
  });

  // Nothing else reconciles a VideoJob whose worker died — the queue's own
  // recovery sweep only repairs Job rows — and this poll is exactly when an
  // operator is staring at the progress bar it left behind. after() keeps the
  // sweep off the response path.
  const watching = jobs.some((j) => j.status === "QUEUED" || j.status === "RUNNING");
  if (watching && Date.now() - lastReconcileAt > RECONCILE_EVERY_MS) {
    lastReconcileAt = Date.now();
    after(async () => {
      await reconcileStalledVideoJobs().catch((err) => log.warn("stalled video job sweep failed", errorFields(err)));
    });
  }

  return ok({ jobs });
});

const startSchema = z.object({
  projectId: z.string().min(1),
  kind: z.enum(["PREVIEW", "EXPORT", "TRANSCRIBE", "THUMBNAIL"]),
  /** TRANSCRIBE only: the language to expect, when the operator knows it. */
  languageHint: z.enum(["uz", "ru", "en"]).optional(),
  /** THUMBNAIL only. */
  atSec: z.number().min(0).max(86_400).optional(),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, startSchema);
  enforceRateLimit(`video-job:${auth.admin.id}`, 30, 60_000);

  const project = await prisma.videoProject.findFirst({
    where: { id: body.projectId, ...(await accountScope(auth)) },
    include: { sourceAsset: { select: { id: true, status: true, hasAudio: true } } },
  });
  if (!project) throw notFound("Video project");
  if (!project.sourceAsset) throw validationError("Upload a video to this project first");
  if (project.sourceAsset.status !== "READY") {
    throw validationError("The source video is still being checked — try again in a moment.");
  }

  const caps = await videoCapabilities();
  if (!caps.rendering.available) {
    throw new AppError("SERVICE_UNAVAILABLE", "Video processing is not available right now", {
      status: 503,
      reason: caps.rendering.reason ?? undefined,
      fix: caps.rendering.fix ?? undefined,
    });
  }
  if (body.kind === "TRANSCRIBE") {
    if (!project.sourceAsset.hasAudio) {
      throw validationError("This video has no audio track, so there is nothing to transcribe.");
    }
    if (!caps.subtitlesAuto.available) {
      throw new AppError("SERVICE_UNAVAILABLE", "Automatic subtitles are not available", {
        status: 503,
        reason: caps.subtitlesAuto.reason ?? undefined,
        fix: caps.subtitlesAuto.fix ?? undefined,
      });
    }
  }

  // Freeze the parameters into the job so editing while it renders cannot
  // change what is being rendered.
  const params = editParamsSchema.parse(project.params ?? {});
  const jobParams: Record<string, unknown> =
    body.kind === "TRANSCRIBE"
      ? { languageHint: body.languageHint }
      : body.kind === "THUMBNAIL"
        ? { atSec: body.atSec ?? 0 }
        : { params };

  const job = await enqueueVideoJob({
    accountId: project.accountId,
    projectId: project.id,
    kind: body.kind,
    params: jobParams,
    createdById: auth.admin.id,
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.STARTED_VIDEO_RENDER,
    resourceType: "VideoJob",
    resourceId: job.id,
    after: { kind: body.kind, projectId: project.id },
    ip: clientIp(req),
  });

  // The video lane is not drained by web requests, but a co-located worker in
  // development picks it up immediately.
  after(() => drainNow(2));
  return ok({ job });
});
