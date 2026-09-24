import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, parseBody, clientIp } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError } from "@/lib/errors";
import { subtitleStyleSchema, editParamsSchema } from "@/lib/video/params";
import { cuesSchema, normalizeCues, applyPreset, buildSrtFile, buildVttFile, parseSubtitleFile, type SubtitleCue } from "@/lib/video/subtitles";

/**
 * Subtitle tracks: create, edit cues, restyle, import and export.
 *
 * Word-level highlighting is only honoured when the track actually carries word
 * timings. Turning it on for a track without them would drift visibly from the
 * speech, so the flag is stored but reported back as inactive.
 */

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const projectId = req.nextUrl.searchParams.get("projectId");
  const format = req.nextUrl.searchParams.get("format");
  const trackId = req.nextUrl.searchParams.get("trackId");

  if (trackId && (format === "srt" || format === "vtt")) {
    const track = await prisma.subtitleTrack.findFirst({
      where: { id: trackId, project: await accountScope(auth) },
      include: { project: { select: { title: true } } },
    });
    if (!track) throw notFound("Subtitle track");
    const cues = normalizeCues((track.cues as unknown as SubtitleCue[]) ?? []);
    const body = format === "srt" ? buildSrtFile(cues) : buildVttFile(cues);
    return new Response(body, {
      headers: {
        "content-type": format === "srt" ? "application/x-subrip; charset=utf-8" : "text/vtt; charset=utf-8",
        // RFC 5987 so non-Latin project titles survive the header.
        "content-disposition": `attachment; filename="subtitles.${format}"; filename*=UTF-8''${encodeURIComponent(track.project.title)}.${format}`,
      },
    });
  }

  if (!projectId) throw validationError("projectId is required");
  const project = await prisma.videoProject.findFirst({
    where: { id: projectId, ...(await accountScope(auth)) },
    select: { id: true },
  });
  if (!project) throw notFound("Video project");

  const tracks = await prisma.subtitleTrack.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "desc" },
  });

  return ok({
    tracks: tracks.map((t) => {
      const cues = (t.cues as unknown as SubtitleCue[]) ?? [];
      return {
        ...t,
        cueCount: cues.length,
        hasWordTimings: cues.some((c) => Array.isArray(c.words) && c.words.length > 0),
      };
    }),
  });
});

const createSchema = z.object({
  projectId: z.string().min(1),
  language: z.string().trim().min(1).max(20).default("uz"),
  cues: cuesSchema.optional(),
  /** Raw SRT/VTT content to import instead of inline cues. */
  importText: z.string().max(2_000_000).optional(),
  preset: z
    .enum(["clean-white", "bold-social", "minimal", "high-contrast", "creator", "highlighted-words", "professional"])
    .default("clean-white"),
  makeDefault: z.boolean().default(true),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, createSchema);

  const project = await prisma.videoProject.findFirst({
    where: { id: body.projectId, ...(await accountScope(auth)) },
  });
  if (!project) throw notFound("Video project");

  const cues = body.importText ? parseSubtitleFile(body.importText) : normalizeCues(body.cues ?? []);
  if (body.importText && cues.length === 0) {
    throw validationError("No subtitles could be read from that file. Expected SRT or WebVTT.");
  }

  const track = await prisma.subtitleTrack.create({
    data: {
      projectId: project.id,
      language: body.language,
      source: body.importText ? "IMPORTED" : "MANUAL",
      cues: cues as never,
      style: applyPreset(body.preset) as never,
      isDefault: body.makeDefault,
    },
  });

  if (body.makeDefault) {
    const params = editParamsSchema.parse(project.params ?? {});
    await prisma.videoProject.update({
      where: { id: project.id },
      data: { params: { ...params, subtitles: { ...params.subtitles, trackId: track.id } } as never },
    });
  }

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPDATED_VIDEO_PROJECT,
    resourceType: "SubtitleTrack",
    resourceId: track.id,
    after: { projectId: project.id, cues: cues.length, source: track.source },
    ip: clientIp(req),
  });

  return ok({ track, cueCount: cues.length });
});

const patchSchema = z.object({
  trackId: z.string().min(1),
  cues: cuesSchema.optional(),
  style: subtitleStyleSchema.partial().optional(),
  language: z.string().trim().min(1).max(20).optional(),
  makeDefault: z.boolean().optional(),
});

export const PATCH = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, patchSchema);

  const track = await prisma.subtitleTrack.findFirst({
    where: { id: body.trackId, project: await accountScope(auth) },
    include: { project: true },
  });
  if (!track) throw notFound("Subtitle track");

  const data: Record<string, unknown> = {};
  if (body.cues) data.cues = normalizeCues(body.cues) as never;
  if (body.language) data.language = body.language;
  if (body.style) {
    const current = subtitleStyleSchema.safeParse(track.style ?? {});
    data.style = subtitleStyleSchema.parse({ ...(current.success ? current.data : {}), ...body.style }) as never;
  }

  const updated = await prisma.subtitleTrack.update({ where: { id: track.id }, data: data as never });

  if (body.makeDefault) {
    const params = editParamsSchema.parse(track.project.params ?? {});
    await prisma.videoProject.update({
      where: { id: track.projectId },
      data: { params: { ...params, subtitles: { ...params.subtitles, trackId: track.id } } as never },
    });
  }

  const cues = (updated.cues as unknown as SubtitleCue[]) ?? [];

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.UPDATED_VIDEO_PROJECT,
    resourceType: "SubtitleTrack",
    resourceId: track.id,
    before: { language: track.language, cues: ((track.cues as unknown as SubtitleCue[]) ?? []).length, style: track.style },
    after: { language: updated.language, cues: cues.length, style: updated.style, madeDefault: body.makeDefault === true },
    ip: clientIp(req),
  });

  return ok({
    track: updated,
    cueCount: cues.length,
    hasWordTimings: cues.some((c) => Array.isArray(c.words) && c.words.length > 0),
  });
});

export const DELETE = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const trackId = req.nextUrl.searchParams.get("trackId");
  if (!trackId) throw validationError("trackId is required");

  const track = await prisma.subtitleTrack.findFirst({
    where: { id: trackId, project: await accountScope(auth) },
    include: { project: true },
  });
  if (!track) throw notFound("Subtitle track");

  const cueCount = ((track.cues as unknown as SubtitleCue[]) ?? []).length;
  await prisma.subtitleTrack.delete({ where: { id: track.id } });

  // A project must never point at a track that no longer exists.
  const params = editParamsSchema.parse(track.project.params ?? {});
  if (params.subtitles.trackId === track.id) {
    await prisma.videoProject.update({
      where: { id: track.projectId },
      data: { params: { ...params, subtitles: { ...params.subtitles, trackId: null } } as never },
    });
  }

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.DELETED_VIDEO_PROJECT,
    resourceType: "SubtitleTrack",
    resourceId: track.id,
    before: { projectId: track.projectId, language: track.language, source: track.source, cues: cueCount },
    ip: clientIp(req),
  });

  return ok({ deleted: true });
});
