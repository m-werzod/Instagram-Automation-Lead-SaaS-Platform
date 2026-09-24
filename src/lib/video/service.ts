import { prisma } from "@/lib/prisma";
import { isVideoWorkerOnline } from "@/lib/queue";
import { ffmpegAvailability } from "./ffmpeg";
import { sttStatus } from "./stt";
import { storageStatus } from "@/lib/storage";
import { aiKeyFor } from "@/lib/env";

/**
 * Capability reporting for the AI Video Editor.
 *
 * The editor deliberately refuses to look functional when its dependencies are
 * absent. Rendering needs FFmpeg on a resident worker; automatic subtitles need
 * a transcription provider; style analysis needs a vision model; large uploads
 * need somewhere to put the bytes. Each is reported separately, with the real
 * reason and the exact fix, so an operator is never left waiting on a job that
 * nothing can run.
 */

export interface VideoCapability {
  available: boolean;
  reason: string | null;
  fix: string | null;
  detail?: string | null;
}

export interface VideoCapabilities {
  /** Can a render actually execute right now? */
  rendering: VideoCapability;
  /** Is a worker with FFmpeg currently polling the video lane? */
  worker: VideoCapability;
  storage: VideoCapability & { driver: string; maxUploadMb: number };
  subtitlesAuto: VideoCapability;
  sampleAnalysis: VideoCapability;
  chatAssistant: VideoCapability;
  /** Publishing a finished export to Instagram. */
  publishing: VideoCapability;
}

export async function videoCapabilities(): Promise<VideoCapabilities> {
  const [ff, workerOnline] = await Promise.all([ffmpegAvailability(), isVideoWorkerOnline()]);
  const storage = storageStatus();
  const stt = sttStatus();
  const hasGoogle = Boolean(aiKeyFor("google"));
  const hasChatKey = Boolean(aiKeyFor("openai") || aiKeyFor("anthropic") || aiKeyFor("google"));

  /**
   * What decides whether a render can happen is whether a WORKER that can
   * render is online — never whether this process has FFmpeg. On the documented
   * deployment the web tier is serverless and never has FFmpeg, so asking about
   * the local binary here would refuse every render while a perfectly healthy
   * worker sat idle. The local probe is kept only as context for the
   * single-host case, where the same machine runs both.
   */
  const workerCap: VideoCapability = workerOnline
    ? {
        available: true,
        reason: null,
        fix: null,
        detail: ff.available ? (ff.ffmpegVersion ?? "FFmpeg available here too") : null,
      }
    : {
        available: false,
        reason: ff.available
          ? "FFmpeg is installed here, but no worker has reported in during the last five minutes, so queued renders will wait."
          : "No worker with FFmpeg has reported in during the last five minutes, so queued renders will wait.",
        fix: "Run `npm run worker` on a machine that has FFmpeg installed (see MANUAL_SETUP_GUIDE.md → Video processing worker). A serverless deployment cannot run renders itself: its functions stop after 60 seconds.",
      };

  /** Work that runs as a video job needs the same worker, whatever else it needs. */
  const needsWorker = (cap: VideoCapability): VideoCapability =>
    cap.available && !workerOnline
      ? { available: false, reason: workerCap.reason, fix: workerCap.fix, detail: cap.detail }
      : cap;

  return {
    rendering: workerCap,
    worker: workerCap,
    storage: {
      available: storage.configured,
      reason: storage.reason,
      fix: storage.reason ? "See MANUAL_SETUP_GUIDE.md → Video storage." : null,
      driver: storage.driver,
      maxUploadMb: storage.maxUploadMb,
    },
    // Transcription and style analysis both run as video jobs, so a configured
    // provider alone is not enough to call them available.
    subtitlesAuto: needsWorker(
      stt.available
        ? { available: true, reason: null, fix: null, detail: `${stt.provider} (${stt.model})` }
        : { available: false, reason: stt.reason, fix: stt.fix },
    ),
    sampleAnalysis: needsWorker(
      hasGoogle
        ? { available: true, reason: null, fix: null, detail: process.env.GEMINI_VIDEO_MODEL?.trim() || "gemini-2.5-flash" }
        : {
            available: false,
            reason: "Style observation needs a vision model; no Google AI key is configured.",
            fix: "Set GOOGLE_AI_API_KEY. Without it, a sample is still measured with FFmpeg (cuts, pacing, loudness, framing) but not visually described.",
          },
    ),
    chatAssistant: hasChatKey
      ? { available: true, reason: null, fix: null }
      : {
          available: false,
          reason: "No AI provider key is configured.",
          fix: "Set AI_API_KEY (with AI_PROVIDER), ANTHROPIC_API_KEY, OPENAI_API_KEY or GOOGLE_AI_API_KEY.",
        },
    publishing: {
      available: true,
      reason: null,
      fix: null,
      detail: "Exports are published through the existing Instagram publishing pipeline, which checks the account's own permissions.",
    },
  };
}

/**
 * Project summary for list views — deliberately excludes `params` and
 * `history`, which are large and only the editor needs them.
 */
export async function listProjects(where: { accountId?: string | { in: string[] } }, take = 50) {
  return prisma.videoProject.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: Math.min(Math.max(take, 1), 100),
    select: {
      id: true,
      accountId: true,
      title: true,
      status: true,
      isDemo: true,
      createdAt: true,
      updatedAt: true,
      sourceAsset: { select: { id: true, filename: true, durationSec: true, width: true, height: true } },
      _count: { select: { jobs: true, subtitle: true } },
    },
  });
}

/** The editor's full view of one project. */
export async function loadProject(projectId: string, where: { accountId?: string | { in: string[] } }) {
  return prisma.videoProject.findFirst({
    where: { id: projectId, ...where },
    include: {
      sourceAsset: true,
      assets: {
        where: { status: { in: ["READY", "UPLOADING"] } },
        orderBy: { createdAt: "desc" },
      },
      subtitle: { orderBy: { createdAt: "desc" } },
      samples: { orderBy: { createdAt: "desc" }, take: 5, include: { sampleAsset: { select: { id: true, filename: true } } } },
      jobs: { orderBy: { createdAt: "desc" }, take: 20 },
      messages: { orderBy: { createdAt: "asc" }, take: 60 },
    },
  });
}
