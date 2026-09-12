import { NextRequest, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, parseBody, assertSameOrigin, clientIp, type RouteCtx, pathParam } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { assertAccountAccess } from "@/lib/auth/access";
import { audit } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { drainNow } from "@/lib/queue";
import { schedulePublishJob } from "@/lib/meta/publishing";

export const GET = route(async (_req, ctx: RouteCtx) => {
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const job = await prisma.publishJob.findUnique({ where: { id }, include: { account: { select: { username: true } } } });
  if (!job) throw notFound("Publication");
  await assertAccountAccess(auth, job.accountId);
  return ok({ job });
});

const actionSchema = z.object({ action: z.enum(["retry", "cancel"]) });

/** retry → back to SCHEDULED (now) with fresh containers; cancel → CANCELLED (only before it is published). */
export const POST = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const { action } = await parseBody(req, actionSchema);

  const job = await prisma.publishJob.findUnique({ where: { id } });
  if (!job) throw notFound("Publication");
  await assertAccountAccess(auth, job.accountId);

  if (action === "retry") {
    if (job.status !== "FAILED" && job.status !== "CANCELLED") throw validationError(`Only failed or cancelled publications can be retried (this one is ${job.status})`);
    const updated = await prisma.publishJob.update({
      where: { id },
      data: { status: "SCHEDULED", scheduledAt: new Date(), attempts: 0, containerId: null, childContainerIds: [], lastError: null, startedAt: null },
    });
    await schedulePublishJob(updated);
    after(() => drainNow());
    await audit({ adminId: auth.admin.id, action: "RETRIED_PUBLISH_JOB", resourceType: "publish_job", resourceId: id, ip: clientIp(req) });
    return ok({ job: updated });
  }

  if (job.status === "PUBLISHED") throw validationError("This publication is already on Instagram — delete it in the Instagram app if needed");
  if (job.status === "CANCELLED") return ok({ job });
  const updated = await prisma.publishJob.update({ where: { id }, data: { status: "CANCELLED" } });
  await audit({ adminId: auth.admin.id, action: "CANCELLED_PUBLISH_JOB", resourceType: "publish_job", resourceId: id, ip: clientIp(req) });
  return ok({ job: updated });
});

/** Remove the record (never the Instagram post itself). */
export const DELETE = route(async (req: NextRequest, ctx: RouteCtx) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const id = await pathParam(ctx, "id");
  const job = await prisma.publishJob.findUnique({ where: { id } });
  if (!job) throw notFound("Publication");
  await assertAccountAccess(auth, job.accountId);
  if (job.status === "PROCESSING") throw validationError("Wait for processing to finish (or cancel) before deleting");
  await prisma.publishJob.delete({ where: { id } });
  return ok({ deleted: true });
});
