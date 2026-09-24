"use client";

import * as React from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Loader2, AlertTriangle, Undo2 } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { EditTab } from "./tabs-edit";
import { AudioTab } from "./tabs-audio";
import { SubtitlesTab } from "./tabs-subtitles";
import { SampleTab } from "./tabs-sample";
import { ChatTab } from "./tabs-chat";
import { ExportTab } from "./tabs-export";
import { JobsPanel } from "./jobs-panel";
import { UploadDrop } from "./upload-drop";
import type { EditorState, ProjectPayload } from "./types";

/**
 * The editor workspace.
 *
 * All editing is one validated parameter object; every tab writes into it and
 * the server re-validates before anything renders. Nothing here simulates
 * progress or success: job state, preview availability and publish readiness
 * all come from the server.
 */

const TABS = ["edit", "audio", "subtitles", "style", "chat", "exportTab"] as const;
type TabKey = (typeof TABS)[number];

export default function VideoProjectPage() {
  const { d } = useI18n();
  const t = d.videoEditor;
  const params = useParams<{ id: string }>();
  const projectId = params.id;

  const [state, setState] = React.useState<EditorState | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<TabKey>("edit");
  const [saving, setSaving] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const data = await api<ProjectPayload>(`/api/video/projects/${projectId}`, { silent: true });
      setState({
        project: data.project,
        capabilities: data.capabilities,
        exportWarnings: data.exportWarnings,
        canUndo: data.canUndo,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.shape.message : d.common.error);
    } finally {
      setLoading(false);
    }
  }, [projectId, d.common.error]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * Poll only while something is actually running. A finished project makes no
   * requests at all, so an idle editor is not a background load generator.
   */
  const hasActiveJob = React.useMemo(
    () => (state?.project.jobs ?? []).some((j) => j.status === "QUEUED" || j.status === "RUNNING"),
    [state],
  );
  React.useEffect(() => {
    if (!hasActiveJob) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [hasActiveJob, load]);

  const saveParams = React.useCallback(
    async (patch: Record<string, unknown>) => {
      setSaving(true);
      try {
        await api(`/api/video/projects/${projectId}`, { method: "PATCH", json: { patch } });
        await load();
      } catch {
        /* api() reported it */
      } finally {
        setSaving(false);
      }
    },
    [projectId, load],
  );

  const [removing, setRemoving] = React.useState(false);

  async function removeFailedSource(assetId: string) {
    setRemoving(true);
    try {
      await api(`/api/video/assets?assetId=${encodeURIComponent(assetId)}`, { method: "DELETE" });
      await load();
    } catch {
      /* api() reported it */
    } finally {
      setRemoving(false);
    }
  }

  async function undo() {
    try {
      await api(`/api/video/projects/${projectId}`, { method: "PATCH", json: { undo: true } });
      await load();
      toast.success(t.undo);
    } catch {
      /* reported */
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-(--color-fg-muted)">
        <Loader2 className="h-4 w-4 animate-spin" /> {d.common.loading}
      </div>
    );
  }

  if (error || !state) {
    return (
      <Card className="space-y-3 p-6">
        <p className="flex items-center gap-2 text-sm text-(--color-danger)">
          <AlertTriangle className="h-4 w-4" /> {error ?? d.common.error}
        </p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            {d.common.tryAgain}
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/video-editor">{d.common.back}</Link>
          </Button>
        </div>
      </Card>
    );
  }

  const { project, capabilities } = state;
  const source = project.sourceAsset;
  // A source that failed its probe can never render anything, so the editor
  // says why instead of leaving every button to fail with "still being checked".
  const sourceFailed = source?.status === "FAILED";
  const sourceChecking = source?.status === "UPLOADING";

  return (
    <div className="space-y-5">
      <PageHeader
        title={project.title}
        description={t.subtitle}
        accent="var(--color-mod-content)"
        actions={
          <>
            <Badge tone={project.status === "READY" ? "ok" : "default"}>{t.status[project.status]}</Badge>
            {saving && <Loader2 className="h-4 w-4 animate-spin text-(--color-fg-faint)" />}
            <Button variant="ghost" size="sm" disabled={!state.canUndo} onClick={() => void undo()}>
              <Undo2 className="mr-1.5 h-4 w-4" />
              {t.undo}
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link href="/video-editor">
                <ArrowLeft className="mr-1.5 h-4 w-4" />
                {d.common.back}
              </Link>
            </Button>
          </>
        }
      />

      {!source ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <UploadDrop
            projectId={project.id}
            role="SOURCE"
            maxUploadMb={capabilities.storage.maxUploadMb}
            disabled={!capabilities.storage.available}
            disabledReason={capabilities.storage.reason}
            onUploaded={() => void load()}
          />
          <Card className="space-y-2 p-5 text-sm text-(--color-fg-muted)">
            <p className="font-medium text-(--color-fg)">{t.upload.source}</p>
            <p>{t.upload.sourceHint}</p>
            {!capabilities.rendering.available && (
              <p className="flex items-start gap-1.5 text-xs">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-warn)" />
                {capabilities.rendering.reason} {capabilities.rendering.fix}
              </p>
            )}
          </Card>
        </div>
      ) : sourceFailed ? (
        <Card className="space-y-3 p-5">
          <p className="flex items-center gap-2 text-sm font-medium text-(--color-danger)">
            <AlertTriangle className="h-4 w-4" /> {t.sourceFailed.title}
          </p>
          <p className="text-sm text-(--color-fg-muted)">
            <span className="text-(--color-fg)">{source.filename}</span> — {source.error ?? t.sourceFailed.unknownReason}
          </p>
          <p className="text-sm text-(--color-fg-muted)">{t.sourceFailed.canReplace}</p>
          <div className="flex flex-wrap gap-2">
            {/* Detaching the failed asset is what actually unblocks the project:
                a completed upload only adopts a new source while sourceAssetId
                is still null. */}
            <Button size="sm" disabled={removing} onClick={() => void removeFailedSource(source.id)}>
              {removing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {removing ? t.sourceFailed.removing : t.sourceFailed.removeAndRetry}
            </Button>
            <Button asChild size="sm" variant="secondary">
              <Link href="/video-editor">{t.sourceFailed.startNew}</Link>
            </Button>
          </div>
        </Card>
      ) : (
        <>
          {sourceChecking && (
            <p className="flex items-start gap-1.5 text-xs text-(--color-fg-muted)">
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
              {t.sourceChecking}
            </p>
          )}

          <div className="flex flex-wrap gap-1 border-b border-(--color-border)">
            {TABS.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
                  tab === key
                    ? "border-(--color-accent) font-medium text-(--color-fg)"
                    : "border-transparent text-(--color-fg-muted) hover:text-(--color-fg)"
                }`}
              >
                {t.tabs[key]}
              </button>
            ))}
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 space-y-5">
              {tab === "edit" && <EditTab state={state} onPatch={saveParams} onReload={load} />}
              {tab === "audio" && <AudioTab state={state} onPatch={saveParams} onReload={load} />}
              {tab === "subtitles" && <SubtitlesTab state={state} onPatch={saveParams} onReload={load} />}
              {tab === "style" && <SampleTab state={state} onReload={load} />}
              {tab === "chat" && <ChatTab state={state} onReload={load} />}
              {tab === "exportTab" && <ExportTab state={state} onReload={load} />}
            </div>
            <JobsPanel state={state} onReload={load} />
          </div>
        </>
      )}
    </div>
  );
}
