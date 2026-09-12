import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { notFound, validationError } from "@/lib/errors";
import { MAX_UPLOAD_BYTES, hostedMediaUrl, isJpeg } from "@/lib/meta/publishing";

/**
 * Upload a media file the platform will host for Meta to download during
 * publishing. Images must be JPEG (Meta's rule). Anything over 4 MB cannot
 * pass through a serverless request body — the UI offers a public URL instead.
 */

export const maxDuration = 30;

const ALLOWED = new Set(["image/jpeg", "video/mp4", "video/quicktime"]);

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();

  const form = await req.formData().catch(() => null);
  if (!form) throw validationError("Expected multipart/form-data with a file");
  const file = form.get("file");
  const accountId = String(form.get("accountId") ?? "");
  if (!(file instanceof File)) throw validationError("Missing file");
  if (!accountId) throw validationError("Missing accountId");

  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  if (file.size > MAX_UPLOAD_BYTES) {
    throw validationError("File is larger than 4 MB", {
      hint: "This hosting cannot receive larger uploads. Put the file on a public https:// URL (your site, a CDN, cloud storage) and paste the link instead.",
    });
  }
  const mime = file.type || "";
  if (!ALLOWED.has(mime)) {
    throw validationError(
      mime.startsWith("image/")
        ? "Instagram accepts JPEG images only — convert PNG/WEBP/HEIC to JPEG first."
        : "Unsupported file type. Use a JPEG image or an MP4/MOV video.",
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (mime === "image/jpeg" && !isJpeg(bytes)) {
    throw validationError("The file is not a real JPEG (wrong signature) — re-export it as JPEG.");
  }

  const asset = await prisma.mediaAsset.create({
    data: {
      accountId: account.id,
      kind: mime.startsWith("video/") ? "VIDEO" : "IMAGE",
      mimeType: mime,
      sizeBytes: bytes.byteLength,
      data: Buffer.from(bytes),
      uploadedById: auth.admin.id,
    },
    select: { id: true, kind: true, mimeType: true, sizeBytes: true },
  });

  return ok({ asset: { ...asset, url: hostedMediaUrl(asset.id, asset.mimeType) } });
});
