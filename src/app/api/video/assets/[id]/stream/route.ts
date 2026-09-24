import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { route } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";
import { notFound } from "@/lib/errors";
import { getStorage } from "@/lib/storage";

/**
 * Authenticated playback for the editor.
 *
 * Range requests are honoured, which is what makes scrubbing a timeline work at
 * all: without 206 responses a browser re-downloads the whole file on every
 * seek. (The existing /m/[id] media route has no Range support — a known
 * limitation for images, an impossible one for video, which is why the editor
 * streams through here instead.)
 */

export const dynamic = "force-dynamic";

export const GET = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await requireAdmin();
  const { id } = await ctx.params;

  const asset = await prisma.videoAsset.findFirst({
    where: { id, ...(await accountScope(auth)) },
    select: { id: true, storageKey: true, mimeType: true, sizeBytes: true, status: true, filename: true },
  });
  if (!asset || asset.status === "DELETED") throw notFound("Video asset");

  const storage = await getStorage();
  const stat = await storage.stat(asset.storageKey);
  const total = stat?.sizeBytes ?? asset.sizeBytes;

  const rangeHeader = req.headers.get("range");
  const headers = new Headers({
    "content-type": asset.mimeType,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "x-content-type-options": "nosniff",
    // Never let a stored file be interpreted as a document in our origin.
    "content-disposition": "inline",
  });

  if (rangeHeader) {
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : Math.max(start, total - 1);
    if (!Number.isFinite(start) || start >= total) {
      return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    }
    const clampedEnd = Math.min(end, total - 1);
    const stream = await storage.read(asset.storageKey, { start, end: clampedEnd });
    headers.set("content-range", `bytes ${start}-${clampedEnd}/${total}`);
    headers.set("content-length", String(clampedEnd - start + 1));
    return new NextResponse(stream as unknown as BodyInit, { status: 206, headers });
  }

  const stream = await storage.read(asset.storageKey);
  headers.set("content-length", String(total));
  return new NextResponse(stream as unknown as BodyInit, { status: 200, headers });
});
