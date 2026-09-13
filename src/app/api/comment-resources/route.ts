import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, clientIp, enforceRateLimit } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope, assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { ALLOWED_RESOURCE_MIME, MAX_RESOURCE_BYTES, resourceKindFromMime } from "@/lib/resources";

/**
 * Files an admin hands to people who comment on a post — see prisma/schema.prisma's
 * CommentResource doc comment for why this is a separate store from MediaAsset.
 */

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId") ?? undefined;
  const resources = await prisma.commentResource.findMany({
    where: await accountScope(auth, accountId),
    select: { id: true, name: true, kind: true, mimeType: true, sizeBytes: true, externalUrl: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return ok({ resources });
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  enforceRateLimit(`comment-resource-upload:${auth.admin.id}`, 20, 60_000);

  const form = await req.formData().catch(() => null);
  if (!form) throw validationError("Expected multipart/form-data with a file");
  const file = form.get("file");
  const accountId = String(form.get("accountId") ?? "");
  const name = form.get("name") ? String(form.get("name")).slice(0, 200) : null;
  if (!(file instanceof File)) throw validationError("Missing file");
  if (!accountId) throw validationError("Missing accountId");

  const account = await prisma.instagramAccount.findUnique({ where: { id: accountId }, select: { id: true } });
  if (!account) throw notFound("Instagram account");
  await assertAccountAccess(auth, account.id);

  if (file.size > MAX_RESOURCE_BYTES) {
    throw validationError("File is larger than 4 MB", {
      hint: "This hosting cannot receive larger uploads. Put the file on a public https:// URL and paste the link instead.",
    });
  }
  const mime = file.type || "";
  if (!ALLOWED_RESOURCE_MIME.has(mime)) {
    throw validationError("Unsupported file type. Use a JPEG/PNG/WEBP image, an MP4/MOV video, a PDF, a DOCX, or a ZIP.");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const resource = await prisma.commentResource.create({
    data: {
      accountId: account.id,
      name: name || file.name,
      kind: resourceKindFromMime(mime),
      mimeType: mime,
      sizeBytes: bytes.byteLength,
      data: Buffer.from(bytes),
      uploadedById: auth.admin.id,
    },
    select: { id: true, name: true, kind: true, mimeType: true, sizeBytes: true, createdAt: true },
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPLOADED_COMMENT_RESOURCE,
    resourceType: "comment_resource",
    resourceId: resource.id,
    after: { name: resource.name, kind: resource.kind },
    ip: clientIp(req),
  });
  return ok({ resource });
});
