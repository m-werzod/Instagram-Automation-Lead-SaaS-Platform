import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, parseBody, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { loadProject, videoCapabilities } from "@/lib/video/service";
import { applyEditPatch, editParamsSchema, diffEditParams, checkExportForInstagram } from "@/lib/video/params";
import { getStorage } from "@/lib/storage";

/** Undo depth. Deep enough for a working session, bounded so the row stays small. */
const HISTORY_LIMIT = 25;

export const GET = route(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  const auth = await requireAdmin();
  const { id } = await ctx.params;
  const project = await loadProject(id, await accountScope(auth));
  if (!project) throw notFound("Video project");

  const capabilities = await videoCapabilities();

  // Warn about Instagram's limits against the newest export, not the source:
  // what matters is the file the operator would actually publish.
  const lastExport = project.assets.find((a) => a.id === project.lastExportId) ?? null;
  const exportWarnings = lastExport
    ? checkExportForInstagram({
        durationSec: lastExport.durationSec,
        width: lastExport.width,
        height: lastExport.height,
        sizeBytes: lastExport.sizeBytes,
        target: "REELS",
      })
    : [];

  return ok({
    project,
    capabilities,
    exportWarnings,
    canUndo: Array.isArray(project.history) && (project.history as unknown[]).length > 0,
  });
});

const patchSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  /** Full replacement of the edit parameters (the timeline UI sends this). */
  params: z.unknown().optional(),
  /** Partial change merged onto the current parameters. */
  patch: z.unknown().optional(),
  status: z.enum(["DRAFT", "READY", "ARCHIVED"]).optional(),
  /** Restore the previous parameters from the undo stack. */
  undo: z.boolean().optional(),
});

export const PATCH = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);

  const project = await prisma.videoProject.findFirst({ where: { id, ...(await accountScope(auth)) } });
  if (!project) throw notFound("Video project");

  const current = editParamsSchema.parse(project.params ?? {});
  const history = Array.isArray(project.history) ? (project.history as unknown[]) : [];

  const data: Record<string, unknown> = {};
  if (body.title !== undefined) data.title = body.title;
  if (body.status !== undefined) data.status = body.status;

  let nextParams = current;
  let changed = false;

  if (body.undo) {
    const previous = history[history.length - 1];
    if (!previous) throw validationError("There is nothing to undo on this project");
    nextParams = editParamsSchema.parse(previous);
    data.history = history.slice(0, -1) as never;
    changed = true;
  } else if (body.params !== undefined) {
    const parsed = editParamsSchema.safeParse(body.params);
    if (!parsed.success) {
      throw validationError("These editing parameters are not valid", {
        reason: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500),
      });
    }
    nextParams = parsed.data;
    changed = true;
  } else if (body.patch !== undefined) {
    try {
      nextParams = applyEditPatch(current, body.patch);
      changed = true;
    } catch (err) {
      throw validationError("That change could not be applied", {
        reason: err instanceof Error ? err.message.slice(0, 400) : undefined,
      });
    }
  }

  if (changed) {
    const diff = diffEditParams(current, nextParams);
    if (diff.length > 0) {
      data.params = nextParams as never;
      if (!body.undo) {
        // Push the pre-change state so every edit is reversible.
        data.history = [...history, current].slice(-HISTORY_LIMIT) as never;
      }
    }
  }

  if (Object.keys(data).length === 0) return ok({ project, changes: [] });

  const updated = await prisma.videoProject.update({ where: { id: project.id }, data: data as never });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPDATED_VIDEO_PROJECT,
    resourceType: "VideoProject",
    resourceId: project.id,
    before: { title: project.title, status: project.status },
    after: { title: updated.title, status: updated.status, undo: Boolean(body.undo) },
    ip: clientIp(req),
  });

  return ok({ project: updated, changes: diffEditParams(current, nextParams) });
});

export const DELETE = route(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const { id } = await ctx.params;

  const project = await prisma.videoProject.findFirst({
    where: { id, ...(await accountScope(auth)) },
    include: { assets: { select: { id: true, storageKey: true } } },
  });
  if (!project) throw notFound("Video project");

  // Storage is cleaned before the rows go, because once the rows are gone the
  // keys are unrecoverable and the files would be orphaned forever.
  const storage = await getStorage();
  for (const asset of project.assets) {
    await storage.delete(asset.storageKey).catch(() => {});
  }

  await prisma.videoProject.delete({ where: { id: project.id } });

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.DELETED_VIDEO_PROJECT,
    resourceType: "VideoProject",
    resourceId: project.id,
    before: { title: project.title, assets: project.assets.length },
    ip: clientIp(req),
  });

  return ok({ deleted: true });
});
