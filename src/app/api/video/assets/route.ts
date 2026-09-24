import { NextRequest, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, parseBody, clientIp, enforceRateLimit } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope, assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { drainNow } from "@/lib/queue";
import { buildStorageKey, getStorage, maxUploadBytes, storageStatus, storageDriverName } from "@/lib/storage";
import { enqueueVideoJob } from "@/lib/video/jobs";

/**
 * Media ingest for the editor.
 *
 * Two paths, because the constraint is a deployment fact rather than a
 * preference:
 *
 *   direct  — the browser uploads straight to Vercel Blob with a short-lived
 *             token. The only way past the 4.5 MB serverless body limit, and
 *             the file never transits a function.
 *   proxied — multipart through this route, for the local driver (a resident
 *             worker or development), where there is no such limit.
 *
 * In both cases the row is created as UPLOADING and only becomes READY after a
 * PROBE job has confirmed with ffprobe that the bytes really are the media the
 * browser claimed. A file that fails that check is marked FAILED and never
 * becomes usable.
 */

export const maxDuration = 60;

const ROLES = ["SOURCE", "AUDIO", "SAMPLE"] as const;

/** Container types FFmpeg handles well and Instagram ultimately accepts. */
const ALLOWED_MIME: Record<(typeof ROLES)[number], string[]> = {
  SOURCE: ["video/mp4", "video/quicktime", "video/x-matroska", "video/webm", "video/x-msvideo"],
  SAMPLE: ["video/mp4", "video/quicktime", "video/x-matroska", "video/webm", "video/x-msvideo"],
  AUDIO: ["audio/mpeg", "audio/mp3", "audio/mp4", "audio/aac", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac", "audio/webm"],
};

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) throw validationError("projectId is required");

  const project = await prisma.videoProject.findFirst({
    where: { id: projectId, ...(await accountScope(auth)) },
    select: { id: true },
  });
  if (!project) throw notFound("Video project");

  const assets = await prisma.videoAsset.findMany({
    where: { projectId: project.id, status: { not: "DELETED" } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true, role: true, status: true, filename: true, mimeType: true, sizeBytes: true,
      durationSec: true, width: true, height: true, hasAudio: true, error: true, createdAt: true,
    },
  });
  return ok({ assets, storage: storageStatus() });
});

const beginSchema = z.object({
  projectId: z.string().min(1),
  role: z.enum(ROLES),
  filename: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(120),
  sizeBytes: z.number().int().positive(),
});

/**
 * Start a direct-to-storage upload. Returns either an upload token (Blob) or an
 * instruction to POST the bytes here instead (local driver).
 */
export const PUT = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, beginSchema);
  enforceRateLimit(`video-upload:${auth.admin.id}`, 60, 60_000);

  const project = await prisma.videoProject.findFirst({
    where: { id: body.projectId, ...(await accountScope(auth)) },
    select: { id: true, accountId: true },
  });
  if (!project) throw notFound("Video project");
  await assertAccountAccess(auth, project.accountId);

  assertAcceptable(body.role, body.mimeType, body.sizeBytes);

  const key = buildStorageKey(project.accountId, body.role.toLowerCase(), body.filename);
  const driver = storageDriverName();

  const asset = await prisma.videoAsset.create({
    data: {
      accountId: project.accountId,
      projectId: project.id,
      role: body.role,
      status: "UPLOADING",
      filename: body.filename.slice(0, 200),
      mimeType: body.mimeType,
      sizeBytes: body.sizeBytes,
      driver,
      storageKey: key,
      uploadedById: auth.admin.id,
    },
  });

  if (driver === "vercel-blob") {
    const { VercelBlobDriver } = await import("@/lib/storage/vercel-blob");
    const blob = new VercelBlobDriver();
    const token = await blob.createClientUploadToken(key, body.mimeType, maxUploadBytes());
    return ok({ asset, upload: { mode: "direct", url: token.url, token: token.token } });
  }

  return ok({ asset, upload: { mode: "proxy", url: `/api/video/assets/${asset.id}/bytes` } });
});

/** Confirm a direct upload finished, and queue the probe that validates it. */
const completeSchema = z.object({ assetId: z.string().min(1), publicUrl: z.string().url().optional() });

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, completeSchema);

  const asset = await prisma.videoAsset.findFirst({
    where: { id: body.assetId, ...(await accountScope(auth)) },
  });
  if (!asset) throw notFound("Video asset");
  if (!asset.projectId) throw validationError("This asset does not belong to a project");

  // Trust the storage layer, not the client: the object must actually exist.
  const storage = await getStorage();
  const stat = await storage.stat(asset.storageKey);
  if (!stat) {
    await prisma.videoAsset.update({
      where: { id: asset.id },
      data: { status: "FAILED", error: "The upload did not arrive in storage." },
    });
    throw validationError("The upload did not complete — nothing arrived in storage.");
  }

  await prisma.videoAsset.update({
    where: { id: asset.id },
    data: { sizeBytes: stat.sizeBytes, publicUrl: body.publicUrl ?? asset.publicUrl },
  });

  const job = await enqueueVideoJob({
    accountId: asset.accountId,
    projectId: asset.projectId,
    kind: "PROBE",
    params: { assetId: asset.id, role: asset.role },
    createdById: auth.admin.id,
    idempotencyKey: `video-probe:${asset.id}`,
  });

  // A source video becomes the project's source once it is probed; setting it
  // here (rather than after the probe) keeps the editor's state predictable.
  if (asset.role === "SOURCE") {
    await prisma.videoProject.updateMany({
      where: { id: asset.projectId, sourceAssetId: null },
      data: { sourceAssetId: asset.id },
    });
  }

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPLOADED_VIDEO_ASSET,
    resourceType: "VideoAsset",
    resourceId: asset.id,
    after: { role: asset.role, filename: asset.filename, sizeBytes: stat.sizeBytes },
    ip: clientIp(req),
  });

  after(() => drainNow(3));
  return ok({ asset: { ...asset, sizeBytes: stat.sizeBytes }, job });
});

function assertAcceptable(role: (typeof ROLES)[number], mimeType: string, sizeBytes: number): void {
  const max = maxUploadBytes();
  if (sizeBytes > max) {
    throw validationError(`This file is larger than the ${Math.floor(max / 1024 / 1024)} MB limit.`, {
      fix: "Raise VIDEO_MAX_UPLOAD_MB, or compress the file before uploading.",
    });
  }
  const allowed = ALLOWED_MIME[role];
  const base = mimeType.split(";")[0]!.trim().toLowerCase();
  if (!allowed.includes(base)) {
    throw validationError(
      role === "AUDIO"
        ? "That is not an audio file this editor accepts. Use MP3, M4A/AAC, WAV, OGG or FLAC."
        : "That is not a video file this editor accepts. Use MP4, MOV, MKV or WebM.",
    );
  }
}

