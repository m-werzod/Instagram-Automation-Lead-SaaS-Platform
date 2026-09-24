import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { parseByteRange } from "@/lib/http/range";
import { getStorage, verifyAssetToken } from "@/lib/storage";

/**
 * Time-limited public delivery of a rendered video, so Meta can download it
 * during publishing.
 *
 * Instagram's publishing API does not accept an upload — it fetches the file
 * from a URL we supply, and keeps fetching for the whole processing window. The
 * Blob driver has its own public URLs, but the local driver does not, so this
 * route provides one: an HMAC over the asset id and an expiry, verified here.
 *
 * Only EXPORT and THUMBNAIL assets are served. A source video or an uploaded
 * music track must never become publicly reachable just because a render used
 * it, and the signature alone would not make that distinction.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const verified = verifyAssetToken(token);
  if (!verified) {
    return NextResponse.json({ ok: false, error: { code: "NOT_FOUND", message: "This link is invalid or has expired" } }, { status: 404 });
  }

  const asset = await prisma.videoAsset.findUnique({
    where: { id: verified.assetId },
    select: { id: true, storageKey: true, mimeType: true, sizeBytes: true, role: true, status: true },
  });
  if (!asset || asset.status !== "READY" || (asset.role !== "EXPORT" && asset.role !== "THUMBNAIL")) {
    return NextResponse.json({ ok: false, error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
  }

  const storage = await getStorage();
  const stat = await storage.stat(asset.storageKey);
  const total = stat?.sizeBytes ?? asset.sizeBytes;

  const headers = new Headers({
    "content-type": asset.mimeType,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=600",
    "x-content-type-options": "nosniff",
    "content-disposition": "inline",
  });

  // Meta's fetcher issues range requests for large media, suffix ranges
  // ("bytes=-500", the LAST 500 bytes) among them — answering those with the
  // head of the file hands it corrupt media it has no way to detect.
  const parsed = parseByteRange(req.headers.get("range"), total);
  if (parsed.kind === "unsatisfiable") {
    return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
  }
  if (parsed.kind === "ok") {
    const { start, end } = parsed.range;
    const stream = await storage.read(asset.storageKey, { start, end });
    headers.set("content-range", `bytes ${start}-${end}/${total}`);
    headers.set("content-length", String(end - start + 1));
    return new NextResponse(stream as unknown as BodyInit, { status: 206, headers });
  }

  const stream = await storage.read(asset.storageKey);
  headers.set("content-length", String(total));
  return new NextResponse(stream as unknown as BodyInit, { status: 200, headers });
}
