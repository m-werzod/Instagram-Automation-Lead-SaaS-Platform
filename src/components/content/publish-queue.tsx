"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, CheckCircle2, ExternalLink, Film, Image as ImageIcon, Images, CircleDashed, Loader2, RotateCcw, Trash2, XCircle } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";

/** Everything published (or waiting to be) from the platform, with real status from the job state machine. */

type Status = "DRAFT" | "SCHEDULED" | "PROCESSING" | "PUBLISHED" | "FAILED" | "CANCELLED";

interface Job {
  id: string;
  mediaType: "IMAGE" | "REELS" | "STORIES" | "CAROUSEL";
  caption: string | null;
  items: Array<{ url: string; kind: string }>;
  status: Status;
  scheduledAt: string;
  publishedAt: string | null;
  permalink: string | null;
  lastError: string | null;
  attempts: number;
}

const TONE: Record<Status, "default" | "info" | "warn" | "ok" | "danger"> = {
  DRAFT: "default",
  SCHEDULED: "info",
  PROCESSING: "warn",
  PUBLISHED: "ok",
  FAILED: "danger",
  CANCELLED: "default",
};

const ICON = { IMAGE: ImageIcon, REELS: Film, STORIES: CircleDashed, CAROUSEL: Images } as const;

export function PublishQueue({ accountId, refreshKey }: { accountId: string; refreshKey: number }) {
  const { d } = useI18n();
  const t = d.content.publish;
  const [jobs, setJobs] = React.useState<Job[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await api<{ jobs: Job[] }>(`/api/publish?accountId=${accountId}`, { silent: true }).catch(() => ({ jobs: [] as Job[] }));
    setJobs(res.jobs);
  }, [accountId]);

  React.useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // keep watching while something is still moving
  const active = jobs?.some((j) => j.status === "SCHEDULED" || j.status === "PROCESSING") ?? false;
  React.useEffect(() => {
    if (!active) return;
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [active, load]);

  async function act(job: Job, action: "retry" | "cancel" | "delete") {
    setBusy(job.id);
    try {
      if (action === "delete") await api(`/api/publish/${job.id}`, { method: "DELETE" });
      else await api(`/api/publish/${job.id}`, { method: "POST", json: { action } });
      toast.success(d.common.done);
      await load();
    } catch {
      /* toast from api() */
    } finally {
      setBusy(null);
    }
  }

  if (!jobs || jobs.length === 0) return null;

  return (
    <Card className="mb-5">
      <CardHeader icon={<IconChip color="var(--color-mod-content)"><CalendarClock size={16} /></IconChip>} title={t.queue} />
      <CardBody className="divide-y divide-(--color-border) p-0">
        {jobs.map((job) => {
          const Icon = ICON[job.mediaType] ?? ImageIcon;
          const StatusIcon =
            job.status === "PUBLISHED" ? CheckCircle2 : job.status === "FAILED" ? XCircle : job.status === "PROCESSING" ? Loader2 : CalendarClock;
          return (
            <div key={job.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
              <IconChip color="var(--color-mod-content)" size={36}>
                <Icon size={16} />
              </IconChip>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{t.types[job.mediaType]}</span>
                  <Badge tone={TONE[job.status]}>
                    <StatusIcon size={11} className={job.status === "PROCESSING" ? "animate-spin" : undefined} /> {t.statuses[job.status]}
                  </Badge>
                  {job.items.length > 1 && <span className="text-[11px] text-(--color-fg-faint)">{job.items.length} ×</span>}
                </div>
                <p className="mt-0.5 line-clamp-1 text-xs text-(--color-fg-muted)">{job.caption ?? "—"}</p>
                <p className="mt-0.5 text-[11px] text-(--color-fg-faint)">
                  {job.status === "PUBLISHED" && job.publishedAt ? `${t.statuses.PUBLISHED}: ${formatDate(job.publishedAt)}` : `${t.scheduledFor}: ${formatDate(job.scheduledAt)}`}
                  {job.attempts > 1 && job.status === "PROCESSING" ? ` · ${t.checks(job.attempts)}` : ""}
                </p>
                {job.lastError && (
                  <p className="mt-1 flex items-start gap-1.5 rounded-md bg-(--color-danger-soft) px-2 py-1.5 text-[11px] leading-4 text-(--color-danger)">
                    <AlertTriangle size={12} className="mt-px shrink-0" /> <span className="min-w-0 break-words">{job.lastError}</span>
                  </p>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                {job.permalink && (
                  <Button asChild size="sm" variant="secondary">
                    <a href={job.permalink} target="_blank" rel="noreferrer">
                      <ExternalLink size={13} /> {t.openPost}
                    </a>
                  </Button>
                )}
                {(job.status === "FAILED" || job.status === "CANCELLED") && (
                  <Button size="sm" variant="secondary" disabled={busy === job.id} onClick={() => void act(job, "retry")}>
                    <RotateCcw size={13} /> {t.retry}
                  </Button>
                )}
                {(job.status === "SCHEDULED" || job.status === "PROCESSING") && (
                  <Button size="sm" variant="danger" disabled={busy === job.id} onClick={() => void act(job, "cancel")}>
                    <XCircle size={13} /> {t.cancel}
                  </Button>
                )}
                {job.status !== "PROCESSING" && (
                  <Button size="icon" variant="ghost" disabled={busy === job.id} onClick={() => void act(job, "delete")} aria-label={t.delete}>
                    <Trash2 size={13} />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </CardBody>
    </Card>
  );
}
