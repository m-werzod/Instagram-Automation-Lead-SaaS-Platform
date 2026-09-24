import { NextRequest, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp, enforceRateLimit } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { AppError, notFound, validationError } from "@/lib/errors";
import { createLogger } from "@/lib/logger";
import { acquireUploadSlot, UploadStalledError, UploadTooLargeError, UPLOAD_CONCURRENCY } from "@/lib/http/upload-guard";
import { drainNow } from "@/lib/queue";
import { getStorage, maxUploadBytes, UploadTooLargeError as StorageUploadTooLargeError } from "@/lib/storage";
import { enqueueVideoJob } from "@/lib/video/jobs";

/**
 * Byte receiver for the local storage driver.
 *
 * Only reachable when the deployment has a resident worker; a serverless host
 * caps request bodies far below video size, which is exactly why the Blob
 * driver exists and why the upload route hands out a direct token there
 * instead.
 *
 * The body is pulled chunk by chunk and abandoned the moment the running total
 * passes the upload limit, so an oversized body — including one sent chunked,
 * with no Content-Length to check in advance — is never fully allocated. What
 * does get accepted is still assembled in memory, because the storage driver's
 * put() takes a buffer rather than a stream; the concurrency slot is what
 * bounds that, since this route shares its host with the FFmpeg worker and a
 * handful of parallel half-gigabyte uploads would otherwise take the web tier
 * down with them.
 */

const log = createLogger("video-upload");

export const maxDuration = 300;

export const POST = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;

  // Tighter than route()'s blanket write limit, which counts requests without
  // regard to the hundreds of megabytes each one of these may carry.
  enforceRateLimit(`video-bytes:${auth.admin.id}`, 20, 60_000);

  const asset = await prisma.videoAsset.findFirst({ where: { id, ...(await accountScope(auth)) } });
  if (!asset) throw notFound("Video asset");
  if (!asset.projectId) throw validationError("This asset does not belong to a project");
  if (asset.status !== "UPLOADING") throw validationError("This upload has already been completed");

  const max = maxUploadBytes();
  const declared = declaredLength(req, max);

  const slot = acquireUploadSlot(auth.admin.id);
  if (!slot) {
    throw new AppError("RATE_LIMITED", "Too many uploads are already in progress", {
      reason: `This server receives at most ${UPLOAD_CONCURRENCY.perOwner} uploads per admin and ${UPLOAD_CONCURRENCY.total} in total at a time, because each one is held in memory while it is written.`,
      fix: "Wait for the uploads already running to finish, then send this file again.",
    });
  }

  try {
    const storage = await getStorage();
    if (!req.body) throw validationError("The uploaded file was empty");

    // Streamed straight into storage: the body is never assembled in memory, so
    // one tenant's large upload cannot exhaust a host that also runs renders.
    // The driver stops and deletes its partial object the moment the limit is
    // passed, so the remaining bytes are never even read.
    let put;
    try {
      put = await storage.putStream(asset.storageKey, req.body, {
        contentType: asset.mimeType,
        maxBytes: max,
        signal: req.signal,
      });
    } catch (err) {
      if (err instanceof StorageUploadTooLargeError || err instanceof UploadTooLargeError) throw tooLarge(max);
      if (err instanceof UploadStalledError) throw stalled(err);
      throw err;
    }

    if (put.sizeBytes === 0) {
      await storage.delete(asset.storageKey).catch(() => {});
      throw validationError("The uploaded file was empty");
    }
    if (put.sizeBytes !== declared) {
      // Not fatal — the stored size is the real one — but a mismatch means the
      // sender's own accounting is off, which is worth seeing in the logs.
      log.warn("upload length differed from the declared Content-Length", {
        assetId: asset.id,
        declared,
        received: put.sizeBytes,
      });
    }

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
  } finally {
    slot.release();
  }
});

/**
 * The declared body size, refused unless the sender states it.
 *
 * A missing Content-Length is not an inconvenience here, it is the whole
 * bypass: without one there is nothing to check before reading, and the reader
 * would be the only thing standing between a chunked body and the heap. Every
 * client this route is built for (the editor's XHR upload) sends one.
 */
function declaredLength(req: NextRequest, max: number): number {
  const raw = req.headers.get("content-length");
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError("VALIDATION", "This upload did not declare its size", {
      status: 411,
      reason: "The request carries no usable Content-Length header, so its size cannot be checked before the bytes are read.",
      fix: "Upload the file through the editor, which sends the whole file in one request with its length. Chunked uploads are not accepted here.",
    });
  }
  if (value > max) throw tooLarge(max);
  return value;
}

function stalled(err: UploadStalledError): AppError {
  return new AppError("VALIDATION", "The upload stopped part-way", {
    status: 408,
    reason: `No data arrived for ${Math.round(err.idleMs / 1000)}s, so the upload was abandoned — holding it open would keep one of this server's upload slots out of everyone else's reach.`,
    fix: "Check the connection and upload the file again.",
  });
}

function tooLarge(max: number): AppError {
  return new AppError("VALIDATION", `This file is larger than the ${Math.floor(max / 1024 / 1024)} MB limit.`, {
    status: 413,
    reason: "The upload was stopped as soon as it passed the limit, so the rest of the file was never read.",
    fix: "Raise VIDEO_MAX_UPLOAD_MB, or compress the file before uploading.",
  });
}
