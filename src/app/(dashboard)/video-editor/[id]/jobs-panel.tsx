"use client";

import * as React from "react";
import { Play, Loader2, AlertTriangle, CheckCircle2, XCircle, Clock } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import type { EditorState, VideoJobRow } from "./types";

/**
 * Processing status.
 *
 * Progress percentages come from FFmpeg's own reported position, and a job that
 * is queued while no worker is online says so rather than showing a bar that
 * will never move.
 */
export function JobsPanel({ state, onReload }: { state: EditorState; onReload: () => Promise<void> }) {
  const { d } = useI18n();
  const t = d.videoEditor.jobs;
  const [busy, setBusy] = React.useState(false);
  const [openLog, setOpenLog] = React.useState<string | null>(null);

  const jobs = state.project.jobs;
  const workerOffline = !state.capabilities.worker.available;

  async function start(kind: "PREVIEW" | "EXPORT") {
    setBusy(true);
    try {
      await api("/api/video/jobs", { method: "POST", json: { projectId: state.project.id, kind } });
      // Queued is all that happened: the render itself starts when a worker
      // picks the job up, which is never guaranteed to be now.
      toast.message(t.queuedToast, { description: workerOffline ? t.workerOffline : t.queuedHint });
      await onReload();
    } catch {
      /* reported */
    } finally {
      setBusy(false);
    }
  }

  async function cancel(job: VideoJobRow) {
    try {
      await api(`/api/video/jobs/${job.id}`, { method: "DELETE" });
      await onReload();
    } catch {
      /* reported */
    }
  }

  // `updatedAt` is part of both payload rows but is not declared on the shared
  // row types, which this change does not own.
  const projectUpdatedAt = (state.project as { updatedAt?: string }).updatedAt;
  const subtitles = state.project.params?.subtitles;
  // Saving cue text writes the subtitle track, not the project, so the
  // project's own timestamp misses the commonest edit there is once captions
  // are burned into the picture. The render reads exactly this track.
  const burnedInTrack =
    subtitles?.burnIn && subtitles.trackId ? state.project.subtitle.find((tr) => tr.id === subtitles.trackId) : undefined;
  const editedAt = lastEditAt(projectUpdatedAt, (burnedInTrack as { updatedAt?: string } | undefined)?.updatedAt);
  const preview = state.project.assets.find((a) => a.role === "PREVIEW" && a.status === "READY");
  const previewStale = preview ? isPreviewStale(previewRenderedAt(preview.id, preview.createdAt, jobs), editedAt) : false;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t.title} />
        <div className="space-y-3 p-4 pt-0">
          <div className="flex flex-col gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !state.capabilities.rendering.available}
              onClick={() => void start("PREVIEW")}
            >
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
              {t.preview}
            </Button>
          </div>

          {workerOffline && (
            <p className="flex items-start gap-1.5 text-xs text-(--color-fg-muted)">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-warn)" />
              {t.workerOffline}
            </p>
          )}

          {preview && (
            <>
              <video src={`/api/video/assets/${preview.id}/stream`} controls className="w-full rounded-md bg-black" preload="metadata" />
              {previewStale && (
                <p className="flex items-start gap-1.5 text-xs text-(--color-fg-muted)">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-warn)" />
                  {d.videoEditor.unsavedPreview}
                </p>
              )}
            </>
          )}
        </div>
      </Card>

      <Card>
        <CardHeader title={t.progress} />
        <div className="space-y-2 p-4 pt-0">
          {jobs.length === 0 && <p className="text-sm text-(--color-fg-muted)">{t.noJobs}</p>}

          {jobs.slice(0, 8).map((job) => (
            <div key={job.id} className="rounded-md border border-(--color-border) p-2.5">
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <JobIcon status={job.status} />
                  <span className="truncate text-xs">{job.kind}</span>
                </div>
                <span className="shrink-0 text-xs text-(--color-fg-muted)">{statusLabel(job.status, t)}</span>
              </div>

              {job.status === "RUNNING" && (
                <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-(--color-panel-2)">
                  <div className="h-full bg-(--color-accent) transition-all" style={{ width: `${job.progressPct}%` }} />
                </div>
              )}

              {job.error && (
                <p className="mt-1.5 text-xs text-(--color-danger)">{job.error}</p>
              )}

              {job.logTail && (
                <>
                  <button
                    type="button"
                    className="mt-1 text-xs text-(--color-fg-muted) underline"
                    onClick={() => setOpenLog(openLog === job.id ? null : job.id)}
                  >
                    {t.showLog}
                  </button>
                  {openLog === job.id && (
                    <pre className="mt-1 max-h-40 overflow-auto rounded bg-(--color-panel-2) p-2 text-[10px] leading-4">{job.logTail}</pre>
                  )}
                </>
              )}

              {(job.status === "QUEUED" || job.status === "RUNNING") && (
                <Button size="sm" variant="ghost" className="mt-1" onClick={() => void cancel(job)}>
                  {t.cancel}
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

/**
 * When the parameters behind a preview were read.
 *
 * The asset row is written only after FFmpeg finishes, so its own timestamp is
 * later than the settings it was built from: an edit made while the render was
 * running would look older than the file it invalidated. The job that produced
 * it read the parameters when it started, so that is the honest reference; an
 * older preview whose job has scrolled out of the list falls back to the asset.
 */
export function previewRenderedAt(previewId: string, previewCreatedAt: string, jobs: VideoJobRow[]): string {
  const job = jobs.find((j) => j.outputAssetId === previewId);
  return job?.startedAt ?? job?.createdAt ?? previewCreatedAt;
}

/**
 * The most recent of several edit timestamps, ignoring missing and unparsable
 * ones so a bad value can never masquerade as "just now".
 *
 * A preview is out of date with respect to more than the project row: saving
 * subtitle lines touches only the track, and those words are in the picture
 * whenever they are burned in.
 */
export function lastEditAt(...stamps: Array<string | undefined | null>): string | undefined {
  let best: { at: number; raw: string } | undefined;
  for (const raw of stamps) {
    if (!raw) continue;
    const at = Date.parse(raw);
    if (!Number.isFinite(at)) continue;
    if (!best || at > best.at) best = { at, raw };
  }
  return best?.raw;
}

/**
 * A preview shows one specific set of parameters. Once the project is edited
 * again it is a picture of settings that are no longer in force, and showing it
 * unlabelled would present a stale render as the current one.
 *
 * The comparison is deliberately one-sided: with no project timestamp, or an
 * unparsable one, nothing is claimed either way. It can also flag a preview that
 * is still accurate when an unrelated write (a finished export) touched the
 * project — over-warning, never under-warning.
 */
export function isPreviewStale(previewCreatedAt: string, projectUpdatedAt: string | undefined): boolean {
  if (!projectUpdatedAt) return false;
  const rendered = Date.parse(previewCreatedAt);
  const edited = Date.parse(projectUpdatedAt);
  if (!Number.isFinite(rendered) || !Number.isFinite(edited)) return false;
  return edited > rendered;
}

function JobIcon({ status }: { status: VideoJobRow["status"] }) {
  if (status === "RUNNING") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-(--color-accent)" />;
  if (status === "DONE") return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-(--color-ok)" />;
  if (status === "FAILED") return <XCircle className="h-3.5 w-3.5 shrink-0 text-(--color-danger)" />;
  if (status === "CANCELLED") return <XCircle className="h-3.5 w-3.5 shrink-0 text-(--color-fg-faint)" />;
  return <Clock className="h-3.5 w-3.5 shrink-0 text-(--color-fg-faint)" />;
}

function statusLabel(status: VideoJobRow["status"], t: Record<string, string>): string {
  switch (status) {
    case "RUNNING":
      return t.running!;
    case "QUEUED":
      return t.queued!;
    case "DONE":
      return t.done!;
    case "FAILED":
      return t.failed!;
    default:
      return t.cancelled!;
  }
}
