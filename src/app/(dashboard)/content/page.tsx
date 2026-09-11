"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  BarChart3,
  CircleDashed,
  ExternalLink,
  Eye,
  Film,
  Heart,
  Image as ImageIcon,
  Instagram,
  Megaphone,
  MessageCircle,
  MousePointerClick,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { useAccounts } from "@/components/shell/account-context";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Card, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import type { Dictionary } from "@/lib/i18n/dictionaries";

/**
 * Posts & Reels library — a visual grid of everything the account published.
 * Sync pulls fresh media through the official API; each card offers AI
 * analysis, an insights refresh, promotion and the Lead Button hand-off.
 * CTA configuration itself lives on the dedicated /lead-button page.
 */

interface ContentRow {
  id: string;
  mediaType: string;
  mediaProductType: string | null;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  permalink: string | null;
  timestamp: string | null;
  likeCount: number | null;
  commentsCount: number | null;
  insights: Record<string, number> | null;
  isDemo: boolean;
  analysis: {
    leadPotential: string | null;
    recommendedCta: string | null;
    topic: string | null;
  } | null;
}

type Potential = "LOW" | "MEDIUM" | "HIGH";

const POTENTIAL_TONE: Record<Potential, "default" | "warn" | "ok"> = {
  LOW: "default",
  MEDIUM: "warn",
  HIGH: "ok",
};

function asPotential(v: string | null | undefined): Potential | null {
  return v === "LOW" || v === "MEDIUM" || v === "HIGH" ? v : null;
}

/** REELS → reel, STORY → story, FEED (and anything else) → post. */
function mediaKind(item: ContentRow): "reel" | "post" | "story" {
  if (item.mediaProductType === "REELS") return "reel";
  if (item.mediaProductType === "STORY") return "story";
  return "post";
}

export default function ContentPage() {
  const { d } = useI18n();
  const { selected, loading: accountsLoading } = useAccounts();
  const [items, setItems] = React.useState<ContentRow[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!selected) return;
    const data = await api<{ items: ContentRow[] }>(`/api/content?accountId=${selected.id}`, { silent: true }).catch(
      () => ({ items: [] as ContentRow[] }),
    );
    setItems(data.items);
  }, [selected]);

  React.useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  async function sync() {
    if (!selected) return;
    setBusy("sync");
    try {
      const res = await api<{ synced: number }>(`/api/instagram/accounts/${selected.id}/sync`, { method: "POST" });
      toast.success(d.content.syncedOk(res.synced));
      await load();
    } catch {
      /* error toast shown by api() */
    } finally {
      setBusy(null);
    }
  }

  async function analyze(item: ContentRow) {
    setBusy(item.id);
    try {
      await api(`/api/content/${item.id}/analyze`, { method: "POST" });
      toast.success(d.common.done);
      await load();
    } catch {
      /* error toast shown by api() */
    } finally {
      setBusy(null);
    }
  }

  async function refreshInsights(item: ContentRow) {
    setBusy(item.id + ":ins");
    try {
      await api(`/api/content/${item.id}/insights`, { method: "POST" });
      toast.success(d.common.done);
      await load();
    } catch {
      /* error toast shown by api() */
    } finally {
      setBusy(null);
    }
  }

  /* ---------- guards ---------- */

  if (accountsLoading || (selected && items === null)) {
    return <div className="py-20 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</div>;
  }

  if (!selected) {
    return (
      <>
        <PageHeader title={d.content.title} description={d.content.subtitle} accent="var(--color-mod-content)" />
        <EmptyState
          icon={
            <IconChip color="var(--color-mod-instagram)" size={48}>
              <Instagram size={22} />
            </IconChip>
          }
          title={d.shell.noAccount}
          action={
            <Button asChild variant="instagram">
              <Link href="/instagram">{d.leadButton.goConnect}</Link>
            </Button>
          }
        />
      </>
    );
  }

  const list = items ?? [];

  return (
    <>
      <PageHeader
        title={d.content.title}
        description={
          <>
            {d.content.subtitle} — <span className="font-medium text-(--color-fg)">@{selected.username}</span>
          </>
        }
        accent="var(--color-mod-content)"
        actions={
          <Button onClick={sync} disabled={busy === "sync"}>
            <RefreshCw size={15} className={busy === "sync" ? "animate-spin" : undefined} />
            {busy === "sync" ? d.content.syncing : d.content.sync}
          </Button>
        }
      />

      {list.length === 0 ? (
        <EmptyState
          icon={
            <IconChip color="var(--color-mod-content)" size={48}>
              <Film size={22} />
            </IconChip>
          }
          title={d.content.empty}
          action={
            <Button onClick={sync} disabled={busy === "sync"}>
              <RefreshCw size={15} className={busy === "sync" ? "animate-spin" : undefined} />
              {busy === "sync" ? d.content.syncing : d.content.sync}
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4 xl:grid-cols-5">
          {list.map((item) => (
            <MediaCard
              key={item.id}
              item={item}
              d={d}
              busy={busy}
              onAnalyze={() => analyze(item)}
              onInsights={() => refreshInsights(item)}
            />
          ))}
        </div>
      )}
    </>
  );
}

/* ---------- media card ---------- */

function MediaCard({
  item,
  d,
  busy,
  onAnalyze,
  onInsights,
}: {
  item: ContentRow;
  d: Dictionary;
  busy: string | null;
  onAnalyze: () => void;
  onInsights: () => void;
}) {
  const kind = mediaKind(item);
  const kindLabel = d.content[kind];
  const KindIcon = kind === "reel" ? Film : kind === "story" ? CircleDashed : ImageIcon;
  const potential = asPotential(item.analysis?.leadPotential);
  const aiDetail = item.analysis ? [item.analysis.recommendedCta, item.analysis.topic].filter(Boolean).join(" · ") : "";

  return (
    <Card className="group flex flex-col overflow-hidden transition-shadow hover:shadow-md">
      <MediaImage item={item} alt={kindLabel}>
        {/* type + demo chips */}
        <div className="absolute left-1.5 top-1.5 flex items-center gap-1">
          <span className="inline-flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">
            <KindIcon size={10} /> {kindLabel}
          </span>
          {item.isDemo && (
            <span className="rounded-md bg-(--color-warn) px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
              {d.shell.demo}
            </span>
          )}
        </div>

        {/* open on Instagram */}
        {item.permalink && (
          <a
            href={item.permalink}
            target="_blank"
            rel="noreferrer"
            title={d.common.open}
            className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded-md bg-black/45 text-white transition-colors hover:bg-black/70"
          >
            <ExternalLink size={12} />
          </a>
        )}

        {/* engagement strip */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2.5 bg-gradient-to-t from-black/70 via-black/25 to-transparent px-2 pb-1.5 pt-8 text-[11px] font-medium text-white">
          <span className="inline-flex items-center gap-1" title={d.content.likes}>
            <Heart size={11} /> {item.likeCount ?? "—"}
          </span>
          <span className="inline-flex items-center gap-1" title={d.content.comments}>
            <MessageCircle size={11} /> {item.commentsCount ?? "—"}
          </span>
          {typeof item.insights?.views === "number" && (
            <span className="ml-auto inline-flex items-center gap-1" title={d.content.insights}>
              <Eye size={11} /> {item.insights.views}
            </span>
          )}
        </div>
      </MediaImage>

      <div className="flex flex-1 flex-col gap-2 p-2.5">
        <p className="line-clamp-2 min-h-10 text-xs leading-5 text-(--color-fg-muted)" title={item.caption ?? undefined}>
          {item.caption}
        </p>
        <div className="text-[10px] text-(--color-fg-faint)">{formatDate(item.timestamp)}</div>

        {/* AI verdict */}
        {item.analysis && (
          <div className="rounded-lg border border-(--color-mod-ai)/25 bg-(--color-mod-ai)/10 p-2">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-(--color-mod-ai)">
                <Sparkles size={11} /> {d.content.aiSays}
              </span>
              {potential && (
                <Badge tone={POTENTIAL_TONE[potential]} title={d.content.leadPotential} className="px-1 py-0">
                  {d.content.potential[potential]}
                </Badge>
              )}
            </div>
            {aiDetail && <p className="mt-1 line-clamp-3 text-[11px] leading-4 text-(--color-fg)">{aiDetail}</p>}
          </div>
        )}

        <div className="mt-auto flex flex-col gap-1.5 pt-1">
          {!item.analysis && (
            <Button size="sm" variant="secondary" className="w-full" disabled={busy === item.id} onClick={onAnalyze}>
              <Sparkles size={13} className="text-(--color-mod-ai)" />
              {busy === item.id ? d.content.analyzing : d.content.analyze}
            </Button>
          )}
          <Button asChild size="sm" variant="secondary" className="h-auto min-h-7 w-full whitespace-normal py-1 text-center">
            <Link href="/lead-button">
              <MousePointerClick size={13} /> {d.content.useForLeadButton}
            </Link>
          </Button>
          <div className="flex gap-1.5">
            <Button asChild size="sm" variant="ghost" className="flex-1">
              <Link href={`/campaigns?new=1&contentId=${item.id}`}>
                <Megaphone size={13} /> {d.content.promote}
              </Link>
            </Button>
            {!item.isDemo && (
              <Button
                size="sm"
                variant="ghost"
                className="flex-1"
                disabled={busy === item.id + ":ins"}
                onClick={onInsights}
              >
                <BarChart3 size={13} /> {d.content.insights}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

/** 4:5 media area with a graceful gradient fallback (Instagram CDN URLs expire). */
function MediaImage({ item, alt, children }: { item: ContentRow; alt: string; children?: React.ReactNode }) {
  const [ok, setOk] = React.useState(true);
  const src = item.thumbnailUrl ?? item.mediaUrl;
  return (
    <div className="relative aspect-[4/5] w-full overflow-hidden bg-(--color-panel-2)">
      {src && ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
          onError={() => setOk(false)}
        />
      ) : (
        <span className="grid h-full w-full place-items-center bg-gradient-to-br from-fuchsia-500 to-indigo-600 text-white">
          <Film size={28} />
        </span>
      )}
      {children}
    </div>
  );
}
