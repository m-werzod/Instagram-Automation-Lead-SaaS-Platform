import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, parseBody, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { coreEnv } from "@/lib/env";
import { getStorage, isPubliclyReachable, signAssetToken } from "@/lib/storage";
import { checkExportForInstagram } from "@/lib/video/params";
import { canPublishReason } from "@/lib/video/publish-check";

/**
 * Hand a finished export to the Instagram publishing workflow.
 *
 * This route does NOT publish. Instagram's API fetches media from a URL rather
 * than accepting an upload, so what it produces is the publicly reachable URL
 * of the render plus the checks that URL has to pass — and the caller then goes
 * through the platform's existing publish pipeline (container → poll →
 * media_publish), with its own confirmation step. Saying "uploaded to
 * Instagram" at this point would be a lie; the render is merely ready to be.
 */

const prepareSchema = z.object({
  projectId: z.string().min(1),
  /** Which export to publish. Defaults to the project's most recent. */
  assetId: z.string().min(1).optional(),
  mediaType: z.enum(["REELS", "STORIES", "FEED"]).default("REELS"),
});

/** Long enough for Meta to fetch and process, short enough not to be a public host. */
const LINK_TTL_MS = 6 * 60 * 60_000;

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, prepareSchema);

  const project = await prisma.videoProject.findFirst({
    where: { id: body.projectId, ...(await accountScope(auth)) },
    include: {
      account: { include: { permissions: true, tokens: true } },
      assets: { where: { role: { in: ["EXPORT", "THUMBNAIL"] }, status: "READY" }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!project) throw notFound("Video project");

  const exports_ = project.assets.filter((a) => a.role === "EXPORT");
  const asset = body.assetId ? exports_.find((a) => a.id === body.assetId) : exports_[0];
  if (!asset) {
    throw validationError("This project has no finished export yet.", {
      fix: "Run an export first, then publish the result.",
    });
  }

  // The bytes must genuinely be there — a row alone proves nothing.
  const storage = await getStorage();
  const stat = await storage.stat(asset.storageKey);
  if (!stat || stat.sizeBytes === 0) {
    throw validationError("The exported file is missing from storage.", {
      fix: "Run the export again.",
    });
  }

  const publishBlock = canPublishReason(project.account);

  const cover = project.assets.find((a) => a.role === "THUMBNAIL");
  const base = coreEnv().APP_URL;
  const mediaUrl = asset.publicUrl ?? `${base}/v/${signAssetToken(asset.id, LINK_TTL_MS)}`;
  const coverUrl = cover ? (cover.publicUrl ?? `${base}/v/${signAssetToken(cover.id, LINK_TTL_MS)}`) : null;

  const reachable = isPubliclyReachable(mediaUrl);
  const warnings = checkExportForInstagram({
    durationSec: asset.durationSec,
    width: asset.width,
    height: asset.height,
    sizeBytes: stat.sizeBytes,
    target: body.mediaType,
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.EXPORTED_VIDEO_TO_INSTAGRAM,
    resourceType: "VideoAsset",
    resourceId: asset.id,
    after: { projectId: project.id, mediaType: body.mediaType, prepared: true },
    ip: clientIp(req),
  });

  return ok({
    /** Feed straight into POST /api/publish as items: [{url, kind: "VIDEO"}]. */
    publish: {
      accountId: project.accountId,
      mediaType: body.mediaType === "FEED" ? "REELS" : body.mediaType,
      items: [{ url: mediaUrl, kind: "VIDEO" as const }],
      coverUrl,
      suggestedCaption: project.title,
    },
    asset: {
      id: asset.id,
      filename: asset.filename,
      sizeBytes: stat.sizeBytes,
      durationSec: asset.durationSec,
      width: asset.width,
      height: asset.height,
    },
    warnings,
    /**
     * Blocking conditions, reported rather than hidden. Meta fetches the file
     * from the internet, so a render served from localhost or a private address
     * genuinely cannot be published, however complete it is.
     */
    blockers: [
      ...(reachable
        ? []
        : [
            {
              code: "URL_NOT_PUBLIC",
              detail: `Instagram downloads the file from ${new URL(mediaUrl).origin}, which is not reachable from the internet.`,
              fix: "Deploy the platform behind a public HTTPS domain, or configure Vercel Blob storage so renders get their own public URL.",
            },
          ]),
      ...(publishBlock ? [publishBlock] : []),
    ],
  });
});
