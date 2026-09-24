"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Download, Instagram, Loader2, AlertTriangle, Film } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { formatBytes, formatDuration, type EditorState } from "./types";

interface PreparedPublish {
  publish: {
    accountId: string;
    mediaType: "REELS" | "STORIES";
    items: Array<{ url: string; kind: "VIDEO" }>;
    coverUrl: string | null;
    suggestedCaption: string;
  };
  asset: { id: string; filename: string; sizeBytes: number; durationSec: number | null; width: number | null; height: number | null };
  warnings: Array<{ code: string; detail: string }>;
  blockers: Array<{ code: string; detail: string; fix: string }>;
}

/**
 * Export, then hand off to Instagram publishing.
 *
 * The publish button does not post anything. Instagram fetches media from a URL
 * rather than accepting an upload, so this prepares that URL, checks it is
 * actually reachable from the internet, and opens the platform's normal
 * publishing screen with the video filled in — where the operator confirms.
 * Anything that would stop Meta accepting the file is shown here first.
 */
export function ExportTab({ state, onReload }: { state: EditorState; onReload: () => Promise<void> }) {
  const { d } = useI18n();
  const t = d.videoEditor.exportPanel;
  const router = useRouter();

  const [busy, setBusy] = React.useState(false);
  const [prepared, setPrepared] = React.useState<PreparedPublish | null>(null);

  const exports_ = state.project.assets.filter((a) => a.role === "EXPORT" && a.status === "READY");
  const latest = exports_[0];
  const activeExport = state.project.jobs.find((j) => j.kind === "EXPORT" && (j.status === "QUEUED" || j.status === "RUNNING"));

  async function runExport() {
    setBusy(true);
    try {
      await api("/api/video/jobs", { method: "POST", json: { projectId: state.project.id, kind: "EXPORT" } });
      // Nothing has rendered yet — the job is queued, and may sit there if no
      // worker is online. Saying "success" here would invent a finished export.
      toast.message(d.videoEditor.jobs.queuedToast, {
        description: state.capabilities.worker.available ? d.videoEditor.jobs.queuedHint : d.videoEditor.jobs.workerOffline,
      });
      await onReload();
    } catch {
      /* reported */
    } finally {
      setBusy(false);
    }
  }

  async function prepare() {
    setBusy(true);
    try {
      const data = await api<PreparedPublish>("/api/video/export", {
        method: "POST",
        json: { projectId: state.project.id, mediaType: "REELS" },
      });
      setPrepared(data);
    } catch {
      /* reported */
    } finally {
      setBusy(false);
    }
  }

  function goToPublish() {
    if (!prepared) return;
    // The publishing screen reads these and pre-fills its composer; the operator
    // still confirms there before anything reaches Instagram.
    const payload = {
      accountId: prepared.publish.accountId,
      mediaType: prepared.publish.mediaType,
      url: prepared.publish.items[0]?.url,
      coverUrl: prepared.publish.coverUrl,
      caption: prepared.publish.suggestedCaption,
    };
    try {
      window.sessionStorage.setItem("video-editor-publish", JSON.stringify(payload));
    } catch {
      /* private mode — the content page falls back to an empty composer */
    }
    router.push("/content?fromVideoEditor=1");
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t.title} />
        <div className="space-y-3 p-4 pt-0">
          <Button disabled={busy || Boolean(activeExport) || !state.capabilities.rendering.available} onClick={() => void runExport()}>
            {busy || activeExport ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Film className="mr-1.5 h-4 w-4" />}
            {t.exportNow}
          </Button>

          {!state.capabilities.rendering.available && (
            <p className="flex items-start gap-1.5 text-xs text-(--color-fg-muted)">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-warn)" />
              {state.capabilities.rendering.reason} {state.capabilities.rendering.fix}
            </p>
          )}
        </div>
      </Card>

      {!latest ? (
        <Card className="p-6 text-sm text-(--color-fg-muted)">{t.noExport}</Card>
      ) : (
        <Card>
          <CardHeader title={t.lastExport} />
          <div className="space-y-4 p-4 pt-0">
            <video src={`/api/video/assets/${latest.id}/stream`} controls className="max-h-[360px] w-full rounded-md bg-black" preload="metadata" />

            <div className="flex flex-wrap gap-4 text-xs text-(--color-fg-muted)">
              <span>{formatDuration(latest.durationSec)}</span>
              <span>
                {latest.width}×{latest.height}
              </span>
              <span>{formatBytes(latest.sizeBytes)}</span>
            </div>

            {state.exportWarnings.length > 0 && (
              <div className="space-y-1 rounded-md border border-(--color-warn)/25 bg-(--color-warn-soft) p-3 text-xs">
                <p className="font-medium">{t.warnings}</p>
                {state.exportWarnings.map((w) => (
                  <p key={w.code} className="text-(--color-fg-muted)">
                    {w.detail}
                  </p>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button asChild variant="secondary" size="sm">
                <a href={`/api/video/assets/${latest.id}/stream`} download={latest.filename}>
                  <Download className="mr-1.5 h-4 w-4" />
                  {t.download}
                </a>
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void prepare()}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Instagram className="mr-1.5 h-4 w-4" />}
                {t.publish}
              </Button>
            </div>

            <p className="text-xs text-(--color-fg-muted)">{t.publishExplain}</p>

            {prepared && (
              <div className="space-y-3 rounded-md border border-(--color-border) p-3">
                {prepared.blockers.length > 0 ? (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-(--color-danger)">{t.blockers}</p>
                    {prepared.blockers.map((b) => (
                      <div key={b.code} className="text-xs text-(--color-fg-muted)">
                        <p>{b.detail}</p>
                        <p>{b.fix}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <>
                    {prepared.warnings.length > 0 && (
                      <div className="space-y-1 text-xs text-(--color-fg-muted)">
                        <p className="font-medium text-(--color-fg)">{t.warnings}</p>
                        {prepared.warnings.map((w) => (
                          <p key={w.code}>{w.detail}</p>
                        ))}
                      </div>
                    )}
                    <Button size="sm" onClick={goToPublish}>
                      <Instagram className="mr-1.5 h-4 w-4" />
                      {t.publish}
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
