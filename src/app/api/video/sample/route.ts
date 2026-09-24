import { NextRequest, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, parseBody, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError, AppError } from "@/lib/errors";
import { drainNow } from "@/lib/queue";
import { enqueueVideoJob } from "@/lib/video/jobs";
import { videoCapabilities } from "@/lib/video/service";
import { planPatch, type PlanItem } from "@/lib/video/sample";
import { applyEditPatch, diffEditParams, editParamsSchema } from "@/lib/video/params";

/**
 * "Edit my video like this one."
 *
 * Analysis produces a plan whose every item states whether this engine can
 * reproduce it exactly, only approximate it, or not do it at all. The operator
 * picks which items to apply; nothing is applied automatically, and nothing
 * claims the sample was reproduced.
 */

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) throw validationError("projectId is required");

  const project = await prisma.videoProject.findFirst({
    where: { id: projectId, ...(await accountScope(auth)) },
    select: { id: true },
  });
  if (!project) throw notFound("Video project");

  const analyses = await prisma.sampleAnalysis.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "desc" },
    take: 10,
    include: { sampleAsset: { select: { id: true, filename: true, durationSec: true } } },
  });
  return ok({ analyses });
});

const startSchema = z.object({
  projectId: z.string().min(1),
  sampleAssetId: z.string().min(1),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, startSchema);

  const project = await prisma.videoProject.findFirst({
    where: { id: body.projectId, ...(await accountScope(auth)) },
    select: { id: true, accountId: true },
  });
  if (!project) throw notFound("Video project");

  const asset = await prisma.videoAsset.findFirst({
    where: { id: body.sampleAssetId, accountId: project.accountId, role: "SAMPLE" },
    select: { id: true, status: true },
  });
  if (!asset) throw notFound("Sample video");
  if (asset.status !== "READY") throw validationError("The sample video is still being checked — try again in a moment.");

  const caps = await videoCapabilities();
  if (!caps.rendering.available) {
    throw new AppError("SERVICE_UNAVAILABLE", "Sample analysis needs the video worker, which is not available", {
      status: 503,
      reason: caps.rendering.reason ?? undefined,
      fix: caps.rendering.fix ?? undefined,
    });
  }

  const analysis = await prisma.sampleAnalysis.create({
    data: { projectId: project.id, sampleAssetId: asset.id, status: "QUEUED" },
  });

  const job = await enqueueVideoJob({
    accountId: project.accountId,
    projectId: project.id,
    kind: "SAMPLE_ANALYZE",
    params: { analysisId: analysis.id },
    createdById: auth.admin.id,
    idempotencyKey: `video-sample:${analysis.id}`,
  });

  after(() => drainNow(2));
  return ok({
    analysis,
    job,
    // Say up front what the AI layer will and will not contribute.
    visionAvailable: caps.sampleAnalysis.available,
    visionReason: caps.sampleAnalysis.reason,
  });
});

const applySchema = z.object({
  analysisId: z.string().min(1),
  /** Which plan items to apply, by their `op`. */
  ops: z.array(z.string().min(1)).min(1).max(20),
});

export const PATCH = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, applySchema);

  const analysis = await prisma.sampleAnalysis.findFirst({
    where: { id: body.analysisId, project: await accountScope(auth) },
    include: { project: true },
  });
  if (!analysis) throw notFound("Sample analysis");
  if (analysis.status !== "DONE") throw validationError("This analysis has not finished yet.");

  const plan = (analysis.plan as unknown as PlanItem[]) ?? [];

  // An item the engine cannot do is never applied, whatever the client asks.
  const unsupported = body.ops.filter((op) => {
    const item = plan.find((p) => p.op === op);
    return !item || item.feasibility === "unsupported" || !item.patch;
  });
  const applicable = body.ops.filter((op) => !unsupported.includes(op));
  if (applicable.length === 0) {
    throw validationError("None of the selected items can be applied by this engine.", {
      reason: "They are marked unsupported, or carry no change.",
    });
  }

  const current = editParamsSchema.parse(analysis.project.params ?? {});
  const next = applyEditPatch(current, planPatch(plan, applicable));
  const changes = diffEditParams(current, next);
  const history = Array.isArray(analysis.project.history) ? (analysis.project.history as unknown[]) : [];

  await prisma.videoProject.update({
    where: { id: analysis.projectId },
    data: { params: next as never, history: [...history, current].slice(-25) as never },
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPDATED_VIDEO_PROJECT,
    resourceType: "VideoProject",
    resourceId: analysis.projectId,
    after: { fromSample: analysis.id, applied: applicable, skipped: unsupported } as never,
    ip: clientIp(req),
  });

  return ok({ applied: applicable, skipped: unsupported, changes, params: next });
});
