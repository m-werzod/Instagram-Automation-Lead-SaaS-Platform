import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, parseBody, clientIp, enforceRateLimit } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope, assertAccountAccess } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound } from "@/lib/errors";
import { listProjects, videoCapabilities } from "@/lib/video/service";
import { defaultEditParams } from "@/lib/video/params";

/**
 * Video projects. Every route under /api/video is metadata-only and fast by
 * design; anything touching media runs as a job in the "video" lane, which only
 * a resident worker with FFmpeg can claim.
 */

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const accountId = req.nextUrl.searchParams.get("accountId") ?? undefined;
  const [projects, capabilities] = await Promise.all([
    listProjects(await accountScope(auth, accountId)),
    videoCapabilities(),
  ]);
  return ok({ projects, capabilities });
});

const createSchema = z.object({
  accountId: z.string().min(1),
  title: z.string().trim().min(1).max(120),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, createSchema);
  await assertAccountAccess(auth, body.accountId);
  enforceRateLimit(`video-project:${auth.admin.id}`, 30, 60_000);

  const account = await prisma.instagramAccount.findUnique({
    where: { id: body.accountId },
    select: { id: true, isDemo: true },
  });
  if (!account) throw notFound("Instagram account");

  const project = await prisma.videoProject.create({
    data: {
      accountId: account.id,
      title: body.title,
      params: defaultEditParams() as never,
      createdById: auth.admin.id,
      isDemo: account.isDemo,
    },
  });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.CREATED_VIDEO_PROJECT,
    resourceType: "VideoProject",
    resourceId: project.id,
    after: { title: project.title, accountId: project.accountId },
    ip: clientIp(req),
  });

  return ok({ project });
});
