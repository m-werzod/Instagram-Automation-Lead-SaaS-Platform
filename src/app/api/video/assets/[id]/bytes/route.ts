import { NextRequest, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { drainNow } from "@/lib/queue";
import { getStorage, maxUploadBytes } from "@/lib/storage";
import { enqueueVideoJob } from "@/lib/video/jobs";

/**
 * Byte receiver for the local storage driver.
 *
 * Only reachable when the deployment has a resident worker; a serverless host
 * caps request bodies far below video size, which is exactly why the Blob
 * driver exists and why the upload route hands out a direct token there
 * instead. The body is streamed to storage rather than buffered whole, so a
 * large upload does not have to fit in memory.
 */

export const maxDuration = 300;

export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;

  const asset = await prisma.videoAsset.findFirst({ where: { id, ...(await accountScope(auth)) } });
  if (!asset) throw notFound("Video asset");
  if (!asset.projectId) throw validationError("This asset does not belong to a project");
  if (asset.status !== "UPLOADING") throw validationError("This upload has already been completed");

  const declared = Number(req.headers.get("content-length") ?? 0);
  const max = maxUploadBytes();
  if (declared > max) {
    throw validationError(`This file is larger than the ${Math.floor(max / 1024 / 1024)} MB limit.`);
  }

  const body = await req.arrayBuffer();
  const bytes = new Uint8Array(body);
  if (bytes.byteLength === 0) throw validationError("The uploaded file was empty");
  // Re-check against the real length; content-length is a client claim.
  if (bytes.byteLength > max) {
    throw validationError(`This file is larger than the ${Math.floor(max / 1024 / 1024)} MB limit.`);
  }

  const storage = await getStorage();
  const put = await storage.put(asset.storageKey, bytes, { contentType: asset.mimeType });

  await prisma.videoAsset.update({
    where: { id: asset.id },
    data: { sizeBytes: put.sizeBytes, publicUrl: put.publicUrl },
  });

  const job = await enqueueVideoJob({
    accountId: asset.accountId,
    projectId: asset.projectId,
    kind: "PROBE",
    params: { assetId: asset.id, role: asset.role },
    createdById: auth.admin.id,
    idempotencyKey: `video-probe:${asset.id}`,
  });

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
    after: { role: asset.role, filename: asset.filename, sizeBytes: put.sizeBytes },
    ip: clientIp(req),
  });

  after(() => drainNow(3));
  return ok({ asset: { id: asset.id, sizeBytes: put.sizeBytes }, job });
});
