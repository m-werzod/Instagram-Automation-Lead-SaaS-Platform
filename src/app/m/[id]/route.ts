import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * PUBLIC media endpoint — Meta downloads publishing assets from here, so it
 * cannot require a session. The id is an unguessable cuid; the extension in
 * the URL is cosmetic (some fetchers key off it) and is ignored.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  const id = raw.replace(/\.[a-z0-9]+$/i, "");
  const asset = await prisma.mediaAsset.findUnique({ where: { id } });
  if (!asset || !asset.data) return new NextResponse("not found", { status: 404 });
  return new NextResponse(new Uint8Array(asset.data), {
    status: 200,
    headers: {
      "Content-Type": asset.mimeType,
      "Content-Length": String(asset.data.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
