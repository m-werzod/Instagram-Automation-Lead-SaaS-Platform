import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

/**
 * PUBLIC comment-resource endpoint — Meta downloads attachment resources from
 * here, and a person the platform sent a "link-fallback" message to opens
 * this URL directly, so it cannot require a session. The id is an
 * unguessable cuid; the extension in the URL is cosmetic and ignored.
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const raw = (await ctx.params).id;
  const id = raw.replace(/\.[a-z0-9]+$/i, "");
  const resource = await prisma.commentResource.findUnique({ where: { id } });
  if (!resource || !resource.data) return new NextResponse("not found", { status: 404 });
  return new NextResponse(new Uint8Array(resource.data), {
    status: 200,
    headers: {
      "Content-Type": resource.mimeType,
      "Content-Length": String(resource.data.byteLength),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename="${resource.name.replace(/["\r\n]/g, "_")}"`,
    },
  });
}
