import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { VideoJob, VideoJobKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { enqueue, registerHandler } from "@/lib/queue";
import { createLogger, errorFields } from "@/lib/logger";
import { buildStorageKey, getStorage } from "@/lib/storage";
import { ffmpeg, parseProgressSeconds, FfmpegMissingError } from "./ffmpeg";
import { probeFile, validateUpload } from "./probe";
import { withWorkspace, type Workspace } from "./workspace";
import {
  buildAudioExtractArgs,
  buildRenderArgs,
  buildThumbnailArgs,
  effectiveDuration,
  resolveTargetSize,
} from "./render";
import { editParamsSchema, type EditParams } from "./params";
import { buildAssFile, normalizeCues, retimeCues, type SubtitleCue } from "./subtitles";
import { subtitleStyleSchema } from "./params";
import { transcribeAudio, SttUnavailableError } from "./stt";
import { buildEditingPlan, measureSample, observeSample } from "./sample";

const log = createLogger("video.jobs");

/**
 * Execution of video work.
 *
 * Every kind of job goes through one queue handler in the "video" lane, so a
 * render can only ever run on a process that proved it has FFmpeg. The handler
 * is deliberately resumable-by-retry rather than checkpointed mid-encode: FFmpeg
 * has no useful resume point, so a failed render restarts, and the queue's
 * backoff and dead-lettering (fixed earlier in this upgrade) stop a reliably
 * failing render from looping forever.
 */

export interface EnqueueVideoJobInput {
  accountId: string;
  projectId: string;
  kind: VideoJobKind;
  params: Record<string, unknown>;
  createdById?: string | null;
  /** Deduplicates identical work; a second enqueue with the same key is a no-op. */
  idempotencyKey?: string;
}

export async function enqueueVideoJob(input: EnqueueVideoJobInput): Promise<VideoJob> {
  // PROBE and SAMPLE_ANALYZE key their work off the asset / analysis id, so the
  // same request arriving twice is ordinary. The queue answers a duplicate key
  // with null, which used to leave a VideoJob row QUEUED that nothing would ever
  // run; hand back the job that already owns the key instead.
  if (input.idempotencyKey) {
    const owner = await videoJobForQueueKey(input.idempotencyKey);
    if (owner) return owner;
  }

  const job = await prisma.videoJob.create({
    data: {
      accountId: input.accountId,
      projectId: input.projectId,
      kind: input.kind,
      params: input.params as never,
      createdById: input.createdById ?? null,
      status: "QUEUED",
    },
  });

  const idempotencyKey = input.idempotencyKey ?? `video:${job.id}`;
  const queued = await enqueue("video.process", { videoJobId: job.id }, { idempotencyKey, maxAttempts: 3 });

  if (queued) {
    return prisma.videoJob.update({ where: { id: job.id }, data: { queueJobId: queued.id } });
  }

  // Lost the race with a concurrent identical request: that one's job is the
  // real one, so drop the row we just made rather than keep a twin nothing runs.
  const owner = await videoJobForQueueKey(idempotencyKey);
  if (owner && owner.id !== job.id) {
    await prisma.videoJob.delete({ where: { id: job.id } }).catch(() => {});
    return owner;
  }

  // The key belongs to a queue entry no VideoJob owns any more, so this row can
  // never be picked up. Say so instead of showing a job queued forever.
  log.warn("video job could not be queued — its idempotency key is held by an orphaned queue entry", {
    videoJobId: job.id,
    kind: job.kind,
    idempotencyKey,
  });
  return prisma.videoJob.update({
    where: { id: job.id },
    data: {
      status: "FAILED",
      error: "Identical work is already queued under the same key, and the job that owns it is gone. Try again once that queue entry has cleared.",
      finishedAt: new Date(),
    },
  });
}

/** The VideoJob that owns the queue entry holding this idempotency key, if any. */
async function videoJobForQueueKey(idempotencyKey: string): Promise<VideoJob | null> {
  const queued = await prisma.job.findUnique({ where: { idempotencyKey }, select: { id: true, payload: true } });
  if (!queued) return null;

  // The queue entry names its VideoJob the instant it exists, while the reverse
  // link (queueJobId) is only written a round-trip later — so a duplicate
  // request landing inside that window has to resolve the owner through the
  // payload, or it would mistake the winner of the race for an orphan.
  const named = (queued.payload as { videoJobId?: unknown } | null)?.videoJobId;
  if (typeof named === "string" && named) {
    const owner = await prisma.videoJob.findUnique({ where: { id: named } });
    if (owner) return owner;
  }

  return prisma.videoJob.findFirst({ where: { queueJobId: queued.id }, orderBy: { createdAt: "desc" } });
}

/** Mark a job cancelled; a running render notices at its next progress tick. */
export async function cancelVideoJob(videoJobId: string): Promise<boolean> {
  const res = await prisma.videoJob.updateMany({
    where: { id: videoJobId, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELLED", cancelledAt: new Date(), finishedAt: new Date() },
  });
  return res.count > 0;
}

async function isCancelled(videoJobId: string): Promise<boolean> {
  const row = await prisma.videoJob.findUnique({ where: { id: videoJobId }, select: { status: true } });
  return row?.status === "CANCELLED";
}

async function setProgress(videoJobId: string, pct: number): Promise<void> {
  await prisma.videoJob
    .updateMany({ where: { id: videoJobId, status: "RUNNING" }, data: { progressPct: Math.max(0, Math.min(99, Math.round(pct))) } })
    .catch(() => {});
}

// ---- asset helpers ----

async function requireAsset(assetId: string, accountId: string) {
  const asset = await prisma.videoAsset.findFirst({
    where: { id: assetId, accountId, status: { in: ["READY", "UPLOADING"] } },
  });
  if (!asset) throw new Error(`Asset ${assetId} was not found for this account`);
  return asset;
}

/**
 * Store a produced file and record it. Uploading before the DB write means a
 * failure never leaves a row pointing at bytes that are not there.
 */
async function storeOutput(input: {
  accountId: string;
  projectId: string;
  role: "EXPORT" | "PREVIEW" | "THUMBNAIL";
  localPath: string;
  filename: string;
  mimeType: string;
}) {
  const storage = await getStorage();
  const bytes = await readFile(input.localPath);
  const key = buildStorageKey(input.accountId, input.role.toLowerCase(), input.filename);
  const put = await storage.put(key, bytes, { contentType: input.mimeType, publicRead: true });

  const probe = input.role === "THUMBNAIL" ? null : await probeFile(input.localPath).catch(() => null);

  return prisma.videoAsset.create({
    data: {
      accountId: input.accountId,
      projectId: input.projectId,
      role: input.role,
      status: "READY",
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: put.sizeBytes,
      driver: storage.name,
      storageKey: key,
      publicUrl: put.publicUrl,
      durationSec: probe?.durationSec ?? null,
      width: probe?.displayWidth ?? null,
      height: probe?.displayHeight ?? null,
      fps: probe?.video?.fps ?? null,
      hasAudio: Boolean(probe?.audio),
      probe: probe ? (probe.raw as never) : undefined,
    },
  });
}

// ---- subtitle rendering ----

/**
 * Write the ASS file for a render. Word highlighting is silently downgraded
 * when the track has no word timings: inventing them would visibly desynchronise
 * from the speech.
 */
async function prepareSubtitles(ws: Workspace, projectId: string, params: EditParams, size: { width: number; height: number }): Promise<string | null> {
  const trackId = params.subtitles.trackId;
  if (!trackId || !params.subtitles.burnIn) return null;

  const track = await prisma.subtitleTrack.findFirst({ where: { id: trackId, projectId } });
  if (!track) return null;

  const stored = normalizeCues((track.cues as unknown as SubtitleCue[]) ?? []);
  if (stored.length === 0) return null;

  // Cues are written against the source; the burn-in lands on the trimmed and
  // speed-adjusted output, so they have to move with it.
  const cues = retimeCues(stored, {
    trimStartSec: params.video.trim?.startSec,
    trimEndSec: params.video.trim?.endSec,
    speed: params.video.speed,
  });
  if (cues.length === 0) return null;

  // The project's style is the operator's current choice and wins; the track's
  // stored style only fills anything the project has not expressed.
  const trackStyle = subtitleStyleSchema.safeParse(track.style ?? {});
  const style = trackStyle.success
    ? subtitleStyleSchema.parse({ ...trackStyle.data, ...params.subtitles.style })
    : params.subtitles.style;

  const hasWordTimings = cues.some((c) => Array.isArray(c.words) && c.words.length > 0);
  const effective = { ...style, wordHighlight: style.wordHighlight && hasWordTimings };

  const ass = buildAssFile(cues, { width: size.width, height: size.height, style: effective });
  return ws.writeFile("subtitles.ass", ass);
}

// ---- job kinds ----

async function runProbeJob(job: VideoJob, ws: Workspace, signal: AbortSignal): Promise<void> {
  const { assetId, role } = job.params as { assetId: string; role?: "SOURCE" | "AUDIO" | "SAMPLE" };
  const asset = await requireAsset(assetId, job.accountId);
  const local = await ws.materialize(asset.storageKey, `probe-${basename(asset.filename)}`, signal);

  try {
    const probe = await validateUpload(local, role ?? "SOURCE", signal);
    await prisma.videoAsset.update({
      where: { id: asset.id },
      data: {
        status: "READY",
        durationSec: probe.durationSec,
        width: probe.displayWidth,
        height: probe.displayHeight,
        fps: probe.video?.fps ?? null,
        hasAudio: Boolean(probe.audio),
        probe: probe.raw as never,
        error: null,
      },
    });
  } catch (err) {
    // A file that is not what it claims must not stay usable.
    await prisma.videoAsset.update({
      where: { id: asset.id },
      data: { status: "FAILED", error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

async function runRenderJob(job: VideoJob, ws: Workspace, signal: AbortSignal, quality: "preview" | "export"): Promise<void> {
  const project = await prisma.videoProject.findFirst({
    where: { id: job.projectId, accountId: job.accountId },
    include: { sourceAsset: true },
  });
  if (!project?.sourceAsset) throw new Error("This project has no source video");

  // The job carries a frozen copy of the parameters, so editing the project
  // while a render runs cannot change what is being rendered.
  const frozen = (job.params as { params?: unknown }).params ?? project.params ?? {};
  const params = editParamsSchema.parse(frozen);

  const source = project.sourceAsset;
  if (!source.width || !source.height) throw new Error("The source video has not been probed yet");

  const sourcePath = await ws.materialize(source.storageKey, `source${extOf(source.filename)}`, signal);

  const audioPaths: string[] = [];
  for (const [i, track] of params.audio.tracks.entries()) {
    const asset = await requireAsset(track.assetId, job.accountId);
    audioPaths.push(await ws.materialize(asset.storageKey, `audio-${i}${extOf(asset.filename)}`, signal));
  }

  const size = resolveTargetSize(params, { width: source.width, height: source.height }, quality);
  const subtitlePath = await prepareSubtitles(ws, project.id, params, size);
  const outPath = ws.path(quality === "preview" ? "preview.mp4" : "export.mp4");

  const built = buildRenderArgs({
    sourcePath,
    audioPaths,
    subtitlePath,
    outputPath: outPath,
    params,
    source: {
      width: source.width,
      height: source.height,
      durationSec: source.durationSec,
      hasAudio: source.hasAudio,
    },
    quality,
  });

  const total = built.expectedDurationSec ?? (source.durationSec ? effectiveDuration(params, source.durationSec) : null);
  let lastTick = 0;

  await ffmpeg(built.args, {
    signal,
    timeoutMs: quality === "preview" ? 15 * 60_000 : 60 * 60_000,
    onStderr: (chunk) => {
      const at = parseProgressSeconds(chunk);
      if (at === null || !total || total <= 0) return;
      const now = Date.now();
      if (now - lastTick < 2000) return;
      lastTick = now;
      void setProgress(job.id, (at / total) * 100);
    },
  });

  if (await isCancelled(job.id)) {
    log.info("render finished but the job was cancelled — discarding output", { videoJobId: job.id });
    return;
  }

  const asset = await storeOutput({
    accountId: job.accountId,
    projectId: project.id,
    role: quality === "preview" ? "PREVIEW" : "EXPORT",
    localPath: outPath,
    filename: `${slug(project.title)}-${quality}.mp4`,
    mimeType: "video/mp4",
  });

  await prisma.videoJob.update({ where: { id: job.id }, data: { outputAssetId: asset.id } });

  if (quality === "export") {
    // A cover frame makes the export directly publishable as a Reel.
    const thumbPath = ws.path("cover.jpg");
    await ffmpeg(buildThumbnailArgs(outPath, thumbPath, Math.min(1, (asset.durationSec ?? 2) / 2)), { signal, timeoutMs: 120_000 }).catch(
      (err) => log.warn("cover frame extraction failed", errorFields(err)),
    );
    const hasThumb = await stat(thumbPath).then(() => true).catch(() => false);
    if (hasThumb) {
      await storeOutput({
        accountId: job.accountId,
        projectId: project.id,
        role: "THUMBNAIL",
        localPath: thumbPath,
        filename: `${slug(project.title)}-cover.jpg`,
        mimeType: "image/jpeg",
      }).catch((err) => log.warn("cover frame could not be stored", errorFields(err)));
    }

    await prisma.videoProject.update({
      where: { id: project.id },
      data: { status: "READY", lastExportId: asset.id },
    });
  }
}

async function runTranscribeJob(job: VideoJob, ws: Workspace, signal: AbortSignal): Promise<void> {
  const { languageHint } = job.params as { languageHint?: string };
  const project = await prisma.videoProject.findFirst({
    where: { id: job.projectId, accountId: job.accountId },
    include: { sourceAsset: true },
  });
  if (!project?.sourceAsset) throw new Error("This project has no source video");
  if (!project.sourceAsset.hasAudio) throw new Error("This video has no audio track to transcribe");

  const sourcePath = await ws.materialize(project.sourceAsset.storageKey, `stt-source${extOf(project.sourceAsset.filename)}`, signal);
  const wavPath = ws.path("speech.wav");
  await ffmpeg(buildAudioExtractArgs(sourcePath, wavPath), { signal, timeoutMs: 20 * 60_000 });
  await setProgress(job.id, 40);

  const result = await transcribeAudio(wavPath, { languageHint, signal });
  await setProgress(job.id, 85);

  const style = subtitleStyleSchema.parse({ wordHighlight: result.hasWordTimings });

  const track = await prisma.subtitleTrack.create({
    data: {
      projectId: project.id,
      language: result.language ?? languageHint ?? "auto",
      source: "AUTO",
      cues: normalizeCues(result.cues) as never,
      style: style as never,
      isDefault: true,
    },
  });

  // Newly generated captions become the ones a render will burn in.
  const current = editParamsSchema.parse(project.params ?? {});
  await prisma.videoProject.update({
    where: { id: project.id },
    data: {
      params: { ...current, subtitles: { ...current.subtitles, trackId: track.id } } as never,
    },
  });

  await prisma.videoJob.update({
    where: { id: job.id },
    data: {
      logTail: `Transcribed with ${result.provider} (${result.model}); ${result.cues.length} cues; word timings: ${result.hasWordTimings ? "yes" : "no"}`,
    },
  });
}

async function runSampleAnalyzeJob(job: VideoJob, ws: Workspace, signal: AbortSignal): Promise<void> {
  const { analysisId } = job.params as { analysisId: string };
  const analysis = await prisma.sampleAnalysis.findFirst({
    where: { id: analysisId, projectId: job.projectId },
    include: { sampleAsset: true, project: { include: { sourceAsset: true } } },
  });
  if (!analysis) throw new Error("Sample analysis record not found");

  await prisma.sampleAnalysis.update({ where: { id: analysis.id }, data: { status: "RUNNING" } });

  try {
    const samplePath = await ws.materialize(analysis.sampleAsset.storageKey, `sample${extOf(analysis.sampleAsset.filename)}`, signal);

    const measured = await measureSample(samplePath, signal);
    await setProgress(job.id, 50);

    const observed = await observeSample(ws, samplePath, measured, signal);
    await setProgress(job.id, 80);

    const target = analysis.project.sourceAsset;
    const plan = buildEditingPlan(measured, observed, {
      width: target?.width ?? 1080,
      height: target?.height ?? 1920,
      durationSec: target?.durationSec ?? null,
    });

    await prisma.sampleAnalysis.update({
      where: { id: analysis.id },
      data: {
        status: "DONE",
        measured: measured as never,
        observed: observed ? (observed as never) : undefined,
        plan: plan as never,
        error: null,
      },
    });
  } catch (err) {
    await prisma.sampleAnalysis.update({
      where: { id: analysis.id },
      data: { status: "FAILED", error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

async function runThumbnailJob(job: VideoJob, ws: Workspace, signal: AbortSignal): Promise<void> {
  const { atSec } = job.params as { atSec?: number };
  const project = await prisma.videoProject.findFirst({
    where: { id: job.projectId, accountId: job.accountId },
    include: { sourceAsset: true },
  });
  if (!project?.sourceAsset) throw new Error("This project has no source video");

  const sourcePath = await ws.materialize(project.sourceAsset.storageKey, `thumb-source${extOf(project.sourceAsset.filename)}`, signal);
  const out = ws.path("frame.jpg");
  await ffmpeg(buildThumbnailArgs(sourcePath, out, atSec ?? 0), { signal, timeoutMs: 120_000 });

  const asset = await storeOutput({
    accountId: job.accountId,
    projectId: project.id,
    role: "THUMBNAIL",
    localPath: out,
    filename: `${slug(project.title)}-frame.jpg`,
    mimeType: "image/jpeg",
  });
  await prisma.videoJob.update({ where: { id: job.id }, data: { outputAssetId: asset.id } });
}

// ---- dispatch ----

export async function runVideoJob(videoJobId: string): Promise<void> {
  const job = await prisma.videoJob.findUnique({ where: { id: videoJobId } });
  if (!job) {
    log.warn("video job vanished before it ran", { videoJobId });
    return;
  }
  if (job.status === "CANCELLED") return;
  if (job.status === "DONE") return;

  if (job.status === "RUNNING") {
    // The queue only re-runs this handler after the previous attempt's lease
    // lapsed, so a row still marked RUNNING means that attempt's process died.
    log.warn("previous attempt of this video job died mid-run — restarting it", {
      videoJobId,
      kind: job.kind,
      startedAt: job.startedAt,
    });
  }

  // Compare-and-set, not a plain update: a cancel landing between the read above
  // and this write must survive instead of being overwritten with RUNNING.
  const claimed = await prisma.videoJob.updateMany({
    where: { id: job.id, status: { in: ["QUEUED", "FAILED", "RUNNING"] } },
    data: { status: "RUNNING", startedAt: new Date(), progressPct: 0, error: null, finishedAt: null },
  });
  if (claimed.count === 0) {
    log.info("video job changed status before this attempt could start — abandoning it", { videoJobId });
    return;
  }

  const controller = new AbortController();
  // A cancellation issued while FFmpeg runs must actually stop it.
  const cancelWatch = setInterval(() => {
    void isCancelled(job.id).then((c) => {
      if (c) controller.abort();
    });
  }, 5000);
  cancelWatch.unref?.();

  try {
    await withWorkspace(async (ws) => {
      switch (job.kind) {
        case "PROBE":
          return runProbeJob(job, ws, controller.signal);
        case "PREVIEW":
          return runRenderJob(job, ws, controller.signal, "preview");
        case "EXPORT":
          return runRenderJob(job, ws, controller.signal, "export");
        case "TRANSCRIBE":
          return runTranscribeJob(job, ws, controller.signal);
        case "SAMPLE_ANALYZE":
          return runSampleAnalyzeJob(job, ws, controller.signal);
        case "THUMBNAIL":
          return runThumbnailJob(job, ws, controller.signal);
        case "WAVEFORM":
          // Not implemented: the timeline reads peaks in the browser instead.
          throw new Error("Waveform extraction is not implemented on the server");
        default:
          throw new Error(`Unknown video job kind: ${job.kind}`);
      }
    });

    // A job cancelled mid-run must not be reported as finished.
    const finalStatus = (await isCancelled(job.id)) ? "CANCELLED" : "DONE";
    await prisma.videoJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: { status: finalStatus, progressPct: finalStatus === "DONE" ? 100 : job.progressPct, finishedAt: new Date() },
    });
  } catch (err) {
    const cancelled = await isCancelled(job.id);
    const message =
      err instanceof FfmpegMissingError
        ? err.message
        : err instanceof SttUnavailableError
          ? `${err.message} ${err.fix}`.trim()
          : err instanceof Error
            ? err.message
            : String(err);

    await prisma.videoJob.updateMany({
      where: { id: job.id, status: "RUNNING" },
      data: {
        status: cancelled ? "CANCELLED" : "FAILED",
        error: message.slice(0, 4000),
        logTail: err && typeof err === "object" && "stderrTail" in err ? String((err as { stderrTail: string }).stderrTail).slice(0, 4000) : undefined,
        finishedAt: new Date(),
      },
    });
    if (!cancelled) throw err;
  } finally {
    clearInterval(cancelWatch);
  }
}

/**
 * Fail video jobs whose runner is gone.
 *
 * recoverStaleJobs reconciles the queue's own rows when a worker is killed, but
 * nothing reconciles the VideoJob behind them: once the queue entry is
 * COMPLETED, dead-lettered or cleaned away, a row left at QUEUED or RUNNING
 * would sit there forever and the editor would show a progress bar that never
 * moves. Meant for the periodic maintenance sweep.
 *
 * The timestamp only narrows the scan — whether the job is really abandoned is
 * decided by the queue entry, so a render that legitimately takes an hour is
 * never touched.
 */
export async function reconcileStalledVideoJobs(staleAfterMs = 15 * 60_000): Promise<number> {
  const cutoff = new Date(Date.now() - Math.max(60_000, staleAfterMs));
  const candidates = await prisma.videoJob.findMany({
    where: { status: { in: ["QUEUED", "RUNNING"] }, updatedAt: { lt: cutoff } },
    select: { id: true, status: true, queueJobId: true },
    take: 200,
  });
  if (candidates.length === 0) return 0;

  const queueJobIds = candidates.map((c) => c.queueJobId).filter((id): id is string => Boolean(id));
  const queueJobs = queueJobIds.length
    ? await prisma.job.findMany({
        where: { id: { in: queueJobIds } },
        select: { id: true, status: true, attempts: true, maxAttempts: true, lockedAt: true, leaseExpiresAt: true },
      })
    : [];

  const now = Date.now();
  // Same signal recoverStaleJobs uses, including its 5-minute fallback for rows
  // claimed before leases existed.
  const leaseHeld = (j: { lockedAt: Date | null; leaseExpiresAt: Date | null }): boolean =>
    (j.leaseExpiresAt?.getTime() ?? (j.lockedAt ? j.lockedAt.getTime() + 5 * 60_000 : 0)) > now;

  // Live means something will still run this: a waiting entry, a retry the queue
  // has left (claimNextJob takes FAILED rows back until attempts run out), or an
  // attempt whose worker still holds the lease. The one combination nothing can
  // revive is a claim whose lease lapsed with no attempts left — recovery
  // dead-letters that — so the VideoJob behind it really is abandoned.
  const live = new Set(
    queueJobs
      .filter(
        (j) =>
          j.status === "PENDING" ||
          (j.status === "FAILED" && j.attempts < j.maxAttempts) ||
          (j.status === "RUNNING" && (leaseHeld(j) || j.attempts < j.maxAttempts)),
      )
      .map((j) => j.id),
  );

  let failed = 0;
  for (const candidate of candidates) {
    if (candidate.queueJobId && live.has(candidate.queueJobId)) continue;
    const res = await prisma.videoJob.updateMany({
      where: { id: candidate.id, status: candidate.status },
      data: {
        status: "FAILED",
        error:
          candidate.status === "RUNNING"
            ? "The worker stopped before this job finished, and the queue is no longer retrying it. Start it again."
            : "Nothing is left in the queue to run this job. Start it again.",
        finishedAt: new Date(),
      },
    });
    failed += res.count;
  }

  if (failed > 0) log.warn("failed video jobs whose queue entry is gone", { count: failed });
  return failed;
}

function extOf(filename: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename);
  return m?.[1] ? `.${m[1].toLowerCase()}` : "";
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "video"
  );
}

/**
 * Registered from here rather than the shared handler file so the video code
 * stays self-contained; the worker imports this module at startup.
 */
export function registerVideoHandlers(): void {
  registerHandler("video.process", async (payload) => {
    const videoJobId = String(payload.videoJobId ?? "");
    if (!videoJobId) throw new Error("video.process requires videoJobId");
    await runVideoJob(videoJobId);
  });
}
