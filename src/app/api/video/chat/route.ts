import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { route, ok, assertSameOrigin, parseBody, clientIp, enforceRateLimit } from "@/lib/api";
import { requireAdmin } from "@/lib/auth/guard";
import { accountScope } from "@/lib/auth/access";
import { audit, AuditActions } from "@/lib/audit";
import { notFound, validationError, AppError } from "@/lib/errors";
import { defaultAiProvider, defaultAiModelOverride } from "@/lib/env";
import { providerTypeOf } from "@/lib/ai";
import { editParamsSchema, applyEditPatch, diffEditParams } from "@/lib/video/params";
import { runAssistantTurn } from "@/lib/video/assistant";
import { videoCapabilities } from "@/lib/video/service";
import type { SubtitleCue } from "@/lib/video/subtitles";

/**
 * The editor's chat assistant.
 *
 * The model proposes; the operator disposes. A turn may return a validated
 * parameter patch, but nothing is applied until a second request confirms it,
 * so an instruction that was misread can never silently rewrite an edit.
 */

export const maxDuration = 60;

export const GET = route(async (req: NextRequest) => {
  const auth = await requireAdmin();
  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) throw validationError("projectId is required");

  const project = await prisma.videoProject.findFirst({
    where: { id: projectId, ...(await accountScope(auth)) },
    select: { id: true },
  });
  if (!project) throw notFound("Video project");

  const messages = await prisma.videoChatMessage.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return ok({ messages });
});

const sendSchema = z.object({
  projectId: z.string().min(1),
  message: z.string().trim().min(1).max(2000),
});

export const POST = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, sendSchema);
  enforceRateLimit(`video-chat:${auth.admin.id}`, 20, 60_000);

  const project = await prisma.videoProject.findFirst({
    where: { id: body.projectId, ...(await accountScope(auth)) },
    include: {
      sourceAsset: { select: { filename: true, durationSec: true, width: true, height: true, hasAudio: true } },
      assets: { where: { role: "AUDIO", status: "READY" }, select: { id: true, filename: true, durationSec: true } },
      subtitle: { orderBy: { createdAt: "desc" }, take: 1 },
      messages: { orderBy: { createdAt: "desc" }, take: 12 },
    },
  });
  if (!project) throw notFound("Video project");

  const caps = await videoCapabilities();
  if (!caps.chatAssistant.available) {
    throw new AppError("SERVICE_UNAVAILABLE", "The editing assistant is not available", {
      status: 503,
      reason: caps.chatAssistant.reason ?? undefined,
      fix: caps.chatAssistant.fix ?? undefined,
    });
  }

  const params = editParamsSchema.parse(project.params ?? {});
  const track = project.subtitle[0];
  const cues = track ? ((track.cues as unknown as SubtitleCue[]) ?? []) : [];
  const subtitleInfo = track
    ? `SUBTITLES: a "${track.language}" track exists with ${cues.length} cues; word timings ${cues.some((c) => c.words?.length) ? "are available" : "are NOT available (do not enable word highlighting)"}.`
    : "SUBTITLES: none yet. The operator must generate or write them before captions can be burned in.";

  const source = project.sourceAsset;
  const sourceLabel = source
    ? `${source.filename}, ${source.durationSec ? `${Math.round(source.durationSec)}s` : "unknown length"}, ${source.width ?? "?"}x${source.height ?? "?"}, ${source.hasAudio ? "has audio" : "NO audio track"}`
    : "no source video uploaded yet";

  await prisma.videoChatMessage.create({
    data: { projectId: project.id, role: "user", text: body.message, state: "NONE" },
  });

  const turn = await runAssistantTurn({
    message: body.message,
    history: project.messages
      .slice()
      .reverse()
      .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), text: m.text })),
    params,
    context: {
      sourceLabel,
      audioAssets: project.assets.map((a) => ({ id: a.id, name: a.filename, durationSec: a.durationSec })),
      subtitleInfo,
      accountId: project.accountId,
      projectId: project.id,
    },
    model: defaultAiModelOverride() ?? "gpt-4o-mini",
    provider: providerTypeOf(defaultAiProvider()),
    adminId: auth.admin.id,
  });

  const saved = await prisma.videoChatMessage.create({
    data: {
      projectId: project.id,
      role: "assistant",
      text: turn.reply || "…",
      proposal: turn.proposal
        ? ({ patch: turn.proposal.patch, summary: turn.proposal.summary, changes: turn.proposal.changes, unsupported: turn.unsupported } as never)
        : undefined,
      state: turn.proposal ? "PROPOSED" : "NONE",
      language: turn.language,
    },
  });

  return ok({
    message: saved,
    proposal: turn.proposal
      ? { messageId: saved.id, summary: turn.proposal.summary, changes: turn.proposal.changes }
      : null,
    unsupported: turn.unsupported,
    language: turn.language,
    usage: { inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, costUsd: turn.costUsd, model: turn.model },
  });
});

const decideSchema = z.object({
  messageId: z.string().min(1),
  accept: z.boolean(),
});

/** Apply or reject a proposal. This is the only path from chat to a real edit. */
export const PATCH = route(async (req: NextRequest) => {
  assertSameOrigin(req);
  const auth = await requireAdmin();
  const body = await parseBody(req, decideSchema);

  const message = await prisma.videoChatMessage.findFirst({
    where: { id: body.messageId, project: await accountScope(auth) },
    include: { project: true },
  });
  if (!message) throw notFound("Assistant message");
  if (message.state !== "PROPOSED") {
    throw validationError("This proposal has already been decided.");
  }

  if (!body.accept) {
    await prisma.videoChatMessage.update({ where: { id: message.id }, data: { state: "REJECTED" } });
    return ok({ applied: false });
  }

  const proposal = message.proposal as { patch?: unknown } | null;
  if (!proposal?.patch) throw validationError("This message carries no change to apply.");

  const current = editParamsSchema.parse(message.project.params ?? {});
  const next = applyEditPatch(current, proposal.patch);
  const changes = diffEditParams(current, next);

  const history = Array.isArray(message.project.history) ? (message.project.history as unknown[]) : [];

  await prisma.$transaction([
    prisma.videoProject.update({
      where: { id: message.projectId },
      data: { params: next as never, history: [...history, current].slice(-25) as never },
    }),
    prisma.videoChatMessage.update({ where: { id: message.id }, data: { state: "APPLIED" } }),
  ]);

  await audit({
    adminId: auth.admin.id,
    action: AuditActions.APPLIED_AI_VIDEO_EDIT,
    resourceType: "VideoProject",
    resourceId: message.projectId,
    before: current as never,
    after: { changes } as never,
    ip: clientIp(req),
  });

  return ok({ applied: true, changes, params: next });
});
