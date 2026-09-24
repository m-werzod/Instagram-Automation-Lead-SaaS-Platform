"use client";

import * as React from "react";
import Link from "next/link";
import { Film, Plus, Trash2, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { useAccounts } from "@/components/shell/account-context";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

/**
 * Project list and capability report.
 *
 * The capability panel is not decoration: rendering needs FFmpeg on a resident
 * worker, subtitles need a transcription provider, and large uploads need
 * storage. Showing which of those is missing — and how to fix it — is what
 * keeps this page honest when the deployment cannot actually do the work.
 */

interface CapabilityShape {
  available: boolean;
  reason: string | null;
  fix: string | null;
  detail?: string | null;
}

interface Capabilities {
  rendering: CapabilityShape;
  worker: CapabilityShape;
  storage: CapabilityShape & { driver: string; maxUploadMb: number };
  subtitlesAuto: CapabilityShape;
  sampleAnalysis: CapabilityShape;
  chatAssistant: CapabilityShape;
  publishing: CapabilityShape;
}

interface ProjectRow {
  id: string;
  title: string;
  status: "DRAFT" | "READY" | "ARCHIVED";
  isDemo: boolean;
  updatedAt: string;
  sourceAsset: { id: string; filename: string; durationSec: number | null; width: number | null; height: number | null } | null;
  _count: { jobs: number; subtitle: number };
}

export default function VideoEditorPage() {
  const { d } = useI18n();
  const t = d.videoEditor;
  const { selected, loading: accountsLoading } = useAccounts();

  const [projects, setProjects] = React.useState<ProjectRow[]>([]);
  const [capabilities, setCapabilities] = React.useState<Capabilities | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [title, setTitle] = React.useState("");
  const [creating, setCreating] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api<{ projects: ProjectRow[]; capabilities: Capabilities }>(
        `/api/video/projects?accountId=${encodeURIComponent(selected.id)}`,
        { silent: true },
      );
      setProjects(data.projects);
      setCapabilities(data.capabilities);
    } catch (err) {
      // A failed load must say so, not sit on a spinner forever.
      setLoadError(err instanceof ApiError ? err.shape.message : d.common.error);
    } finally {
      setLoading(false);
    }
  }, [selected, d.common.error]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function createProject(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !title.trim()) return;
    setCreating(true);
    try {
      const data = await api<{ project: ProjectRow }>("/api/video/projects", {
        method: "POST",
        json: { accountId: selected.id, title: title.trim() },
      });
      setTitle("");
      toast.success(t.create);
      window.location.href = `/video-editor/${data.project.id}`;
    } catch {
      /* api() already reported it */
    } finally {
      setCreating(false);
    }
  }

  async function remove(project: ProjectRow) {
    if (!window.confirm(t.deleteConfirm)) return;
    try {
      await api(`/api/video/projects/${project.id}`, { method: "DELETE" });
      setProjects((rows) => rows.filter((p) => p.id !== project.id));
    } catch {
      /* reported */
    }
  }

  if (accountsLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-(--color-fg-muted)">
        <Loader2 className="h-4 w-4 animate-spin" /> {d.common.loading}
      </div>
    );
  }

  if (!selected) {
    return (
      <div>
        <PageHeader title={t.title} description={t.subtitle} accent="var(--color-mod-content)" />
        <EmptyState title={t.noProjects} description={t.noProjectsHint} icon={<Film className="h-6 w-6 text-(--color-fg-faint)" />} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader title={t.title} description={t.subtitle} accent="var(--color-mod-content)" />

      {capabilities && <CapabilityPanel caps={capabilities} labels={t.capabilities} />}

      <Card className="p-5">
        <form onSubmit={createProject} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="project-title" className="mb-1.5 block text-xs font-medium text-(--color-fg-muted)">
              {t.projectTitle}
            </label>
            <Input
              id="project-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t.newProject}
              maxLength={120}
            />
          </div>
          <Button type="submit" disabled={creating || !title.trim()}>
            {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            {t.create}
          </Button>
        </form>
      </Card>

      {loading ? (
        <Card className="flex items-center gap-2 p-6 text-sm text-(--color-fg-muted)">
          <Loader2 className="h-4 w-4 animate-spin" /> {d.common.loading}
        </Card>
      ) : loadError ? (
        <Card className="space-y-3 p-6">
          <p className="flex items-center gap-2 text-sm text-(--color-danger)">
            <AlertTriangle className="h-4 w-4" /> {loadError}
          </p>
          <Button variant="secondary" size="sm" onClick={() => void load()}>
            {d.common.tryAgain}
          </Button>
        </Card>
      ) : projects.length === 0 ? (
        <EmptyState title={t.noProjects} description={t.noProjectsHint} icon={<Film className="h-6 w-6 text-(--color-fg-faint)" />} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <Card key={project.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{project.title}</p>
                  <p className="mt-0.5 text-xs text-(--color-fg-muted)">
                    {project.sourceAsset
                      ? `${project.sourceAsset.width ?? "?"}×${project.sourceAsset.height ?? "?"}${
                          project.sourceAsset.durationSec ? ` · ${Math.round(project.sourceAsset.durationSec)}s` : ""
                        }`
                      : t.upload.source}
                  </p>
                </div>
                <Badge tone={project.status === "READY" ? "ok" : "default"}>{t.status[project.status]}</Badge>
              </div>
              <div className="mt-auto flex items-center gap-2">
                <Button asChild size="sm" className="flex-1">
                  <Link href={`/video-editor/${project.id}`}>{t.open}</Link>
                </Button>
                <Button variant="ghost" size="sm" aria-label={t.deleteProject} onClick={() => void remove(project)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function CapabilityPanel({ caps, labels }: { caps: Capabilities; labels: typeof import("@/lib/i18n/dictionaries/en").en.videoEditor.capabilities }) {
  const entries: Array<[string, CapabilityShape]> = [
    [labels.rendering, caps.rendering],
    [labels.worker, caps.worker],
    [labels.storage, caps.storage],
    [labels.subtitlesAuto, caps.subtitlesAuto],
    [labels.sampleAnalysis, caps.sampleAnalysis],
    [labels.chatAssistant, caps.chatAssistant],
  ];
  const problems = entries.filter(([, c]) => !c.available);

  return (
    <Card className="space-y-3 p-5">
      <p className="text-sm font-semibold">{labels.title}</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map(([label, cap]) => (
          <div key={label} className="flex items-start gap-2 text-sm">
            {cap.available ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-(--color-ok)" />
            ) : (
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-(--color-warn)" />
            )}
            <div className="min-w-0">
              <p className="truncate">{label}</p>
              <p className="text-xs text-(--color-fg-muted)">
                {cap.available ? (cap.detail ?? labels.available) : labels.unavailable}
              </p>
            </div>
          </div>
        ))}
      </div>

      {problems.length > 0 && (
        <div className="space-y-2 rounded-md border border-(--color-warn)/25 bg-(--color-warn-soft) p-3">
          {problems.map(([label, cap]) => (
            <div key={label} className="text-xs">
              <p className="font-medium">{label}</p>
              {cap.reason && (
                <p className="text-(--color-fg-muted)">
                  {labels.whyUnavailable}: {cap.reason}
                </p>
              )}
              {cap.fix && (
                <p className="text-(--color-fg-muted)">
                  {labels.howToFix}: {cap.fix}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
