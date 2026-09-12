"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  CloudUpload,
  ExternalLink,
  Eye,
  Film,
  Instagram,
  Megaphone,
  MousePointerClick,
  PauseCircle,
  PencilLine,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Sparkles,
  Square,
  Trash2,
  Users,
} from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { useAccounts } from "@/components/shell/account-context";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Card, CardBody, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { centsToMoney, formatDate, timeAgo, truncate } from "@/lib/utils";
import { CampaignWizard, type ContentOption, type WizardInitial, type WizardOptions } from "@/components/campaigns/campaign-wizard";

/**
 * Target — promoted posts and Reels with a real Meta button. The only screen
 * where money can move, so the lifecycle is deliberately slow: local DRAFT →
 * created PAUSED in Meta → typed-name confirmation before anything spends.
 * Audience numbers come from Meta's reach estimate; spend and results come
 * from Meta insights. Nothing here is projected or invented.
 */

interface Targeting {
  countries?: string[];
  cities?: Array<{ key: string; name?: string; radius?: number; distanceUnit?: "kilometer" | "mile" }>;
  ageMin?: number;
  ageMax?: number;
  genders?: number[];
  interests?: Array<{ id: string; name?: string }>;
  instagramPositions?: string[];
}

interface Insights {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  results: number | null;
  resultAction: string | null;
  currency: string;
  fetchedAt: string;
}

type Estimate = { available: true; usersLowerBound: number; usersUpperBound: number; fetchedAt: string } | { available: false; reason: string };

interface CampaignRow {
  id: string;
  name: string;
  objective: string;
  status: string;
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
  currency: string;
  startTime: string | null;
  endTime: string | null;
  ctaType: string | null;
  destinationType: string | null;
  destinationUrl: string | null;
  metaFormId: string | null;
  targeting: Targeting | null;
  creativeSpec: { message?: string } | null;
  createdByAi: boolean;
  metaCampaignId: string | null;
  metaCreativeId: string | null;
  lastError: string | null;
  estimate: Estimate | null;
  insightsSnapshot: Insights | null;
  insightsSyncedAt: string | null;
  createdAt: string;
  publishedAt: string | null;
  stoppedAt: string | null;
  contentId: string | null;
  content: { id: string; caption: string | null; thumbnailUrl: string | null; mediaUrl: string | null; mediaProductType: string | null; permalink: string | null } | null;
  account: { username: string; connectionMode: string; adAccountId: string | null; fbPageId: string | null };
  _count: { leads: number };
}

interface Prefill {
  fromLeadButton: boolean;
  contentId: string;
  ctaType: string | null;
  destinationUrl: string;
}

const STATUS_TONE: Record<string, "default" | "ok" | "warn" | "danger" | "accent" | "info"> = {
  DRAFT: "default",
  READY: "info",
  CREATED: "warn",
  ACTIVE: "ok",
  PAUSED: "warn",
  ARCHIVED: "default",
  ERROR: "danger",
};

export default function CampaignsPage() {
  return (
    <React.Suspense>
      <CampaignsInner />
    </React.Suspense>
  );
}

function CampaignsInner() {
  const { d } = useI18n();
  const { selected, loading: accountsLoading } = useAccounts();
  const params = useSearchParams();

  const [campaigns, setCampaigns] = React.useState<CampaignRow[] | null>(null);
  const [options, setOptions] = React.useState<WizardOptions | null>(null);
  const [contentOptions, setContentOptions] = React.useState<ContentOption[]>([]);
  const [currency, setCurrency] = React.useState("USD");
  const [wizardOpen, setWizardOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<WizardInitial | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const adsCapability = selected?.capabilities.find((c) => c.key === "ads");
  const adsAvailable = Boolean(adsCapability?.available);

  const prefill = React.useMemo<Prefill | null>(() => {
    const fromLeadButton = params.get("new") === "1";
    const contentId = params.get("contentId") ?? "";
    if (!fromLeadButton && !contentId) return null;
    return { fromLeadButton, contentId, ctaType: params.get("cta"), destinationUrl: params.get("url") ?? "" };
  }, [params]);

  const autoOpened = React.useRef(false);
  React.useEffect(() => {
    if (prefill && !autoOpened.current && options) {
      autoOpened.current = true;
      setEditing(null);
      setWizardOpen(true);
    }
  }, [prefill, options]);

  const load = React.useCallback(async () => {
    if (!selected) return;
    const [data, content] = await Promise.all([
      api<{ campaigns: CampaignRow[]; options: WizardOptions }>(`/api/campaigns?accountId=${selected.id}`, { silent: true }),
      api<{ items: ContentOption[] }>(`/api/content?accountId=${selected.id}&take=60`, { silent: true }).catch(() => ({ items: [] as ContentOption[] })),
    ]);
    setCampaigns(data.campaigns);
    setOptions(data.options);
    setContentOptions(content.items);
  }, [selected]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // The ad account's own currency, when advertising is connected.
  React.useEffect(() => {
    if (!selected?.adAccountId) return;
    api<{ adAccounts: Array<{ id: string; currency?: string }> }>(`/api/instagram/accounts/${selected.id}/ad-accounts`, { silent: true })
      .then((res) => {
        const acc = res.adAccounts.find((a) => a.id === selected.adAccountId) ?? res.adAccounts[0];
        if (acc?.currency) setCurrency(acc.currency);
      })
      .catch(() => undefined);
  }, [selected?.id, selected?.adAccountId, selected]);

  async function run(c: CampaignRow, label: string, fn: () => Promise<unknown>, successMessage?: string) {
    setBusy(`${c.id}:${label}`);
    try {
      await fn();
      if (successMessage) toast.success(successMessage);
      await load();
    } catch {
      /* toast from api() */
    } finally {
      setBusy(null);
    }
  }

  if (accountsLoading || (selected && campaigns === null)) {
    return <div className="py-20 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</div>;
  }

  if (!selected) {
    return (
      <div className="mx-auto max-w-5xl">
        <PageHeader title={d.campaigns.title} description={d.campaigns.subtitle} accent="var(--color-mod-ads)" />
        <EmptyState
          icon={<IconChip color="var(--color-mod-instagram)" size={48}><Instagram size={22} /></IconChip>}
          title={d.common.notConnected}
          action={
            <Button asChild variant="instagram">
              <Link href="/instagram">{d.nav.instagram}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={d.campaigns.title}
        description={d.campaigns.subtitle}
        accent="var(--color-mod-ads)"
        actions={
          <Button
            onClick={() => {
              setEditing(null);
              setWizardOpen(true);
            }}
          >
            <Plus size={15} /> {d.campaigns.create}
          </Button>
        }
      />

      {!selected.adAccountId && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-(--color-warn)/30 bg-(--color-warn-soft) px-4 py-3 text-xs leading-5 text-(--color-warn)">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="font-medium">{d.campaigns.needsAds}</span>
          <span className="text-(--color-fg-muted)">{d.campaigns.needsAdsDetail}</span>
          <Link href="/instagram" className="font-semibold underline underline-offset-2">
            {d.nav.instagram} →
          </Link>
        </div>
      )}

      <Card className="overflow-hidden">
        <CardBody className="flex flex-wrap items-center justify-between gap-3 py-3">
          <FlowStep n={1} color="var(--color-fg-muted)" icon={<PencilLine size={15} />} label={d.campaigns.statuses.DRAFT} />
          <ArrowRight size={14} className="hidden shrink-0 text-(--color-fg-faint) md:block" />
          <FlowStep n={2} color="var(--color-mod-ads)" icon={<PauseCircle size={15} />} label={d.campaigns.statuses.CREATED} />
          <ArrowRight size={14} className="hidden shrink-0 text-(--color-fg-faint) md:block" />
          <FlowStep n={3} color="var(--color-ok)" icon={<Rocket size={15} />} label={d.campaigns.statuses.ACTIVE} />
        </CardBody>
      </Card>

      {campaigns?.length === 0 && (
        <EmptyState
          icon={<IconChip color="var(--color-mod-ads)" size={48}><Megaphone size={22} /></IconChip>}
          title={d.campaigns.empty}
          action={
            <Button
              onClick={() => {
                setEditing(null);
                setWizardOpen(true);
              }}
            >
              <Plus size={15} /> {d.campaigns.create}
            </Button>
          }
        />
      )}

      {campaigns?.map((c) => (
        <CampaignCard
          key={c.id}
          c={c}
          options={options}
          busy={busy}
          adsAvailable={adsAvailable}
          adsReason={adsCapability?.reason}
          onEdit={() => {
            setEditing(c);
            setWizardOpen(true);
          }}
          onCreateInMeta={() => run(c, "meta", () => api(`/api/campaigns/${c.id}/create-in-meta`, { method: "POST" }), d.campaigns.statuses.CREATED)}
          onPause={() => run(c, "pause", () => api(`/api/campaigns/${c.id}/pause`, { method: "POST" }), d.campaigns.statuses.PAUSED)}
          onStop={() => run(c, "stop", () => api(`/api/campaigns/${c.id}/stop`, { method: "POST" }), d.campaigns.card.stopped)}
          onSync={() => run(c, "sync", () => api(`/api/campaigns/${c.id}/sync`, { method: "POST" }), d.campaigns.card.syncedOk)}
          onArchive={() => run(c, "archive", () => api(`/api/campaigns/${c.id}`, { method: "PATCH", json: { status: "ARCHIVED" } }))}
          onDelete={() => run(c, "delete", () => api(`/api/campaigns/${c.id}`, { method: "DELETE" }), d.common.done)}
          onReload={load}
        />
      ))}

      {options && (
        <CampaignWizard
          open={wizardOpen}
          onOpenChange={setWizardOpen}
          accountId={selected.id}
          username={selected.username}
          adsReady={adsAvailable}
          hasPage={Boolean(campaigns?.[0]?.account.fbPageId ?? false) || Boolean(selected.adAccountId)}
          currency={currency}
          options={options}
          contentOptions={contentOptions}
          prefill={editing ? null : prefill}
          initial={editing}
          onSaved={load}
        />
      )}
    </div>
  );
}

function FlowStep({ n, color, icon, label }: { n: number; color: string; icon: React.ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 flex-1 basis-40 items-center gap-2.5">
      <IconChip color={color} size={34}>{icon}</IconChip>
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wide text-(--color-fg-faint)">{n}</div>
        <div className="truncate text-xs font-medium">{label}</div>
      </div>
    </div>
  );
}

/* ---------- campaign card ---------- */

function CampaignCard({
  c,
  options,
  busy,
  adsAvailable,
  adsReason,
  onEdit,
  onCreateInMeta,
  onPause,
  onStop,
  onSync,
  onArchive,
  onDelete,
  onReload,
}: {
  c: CampaignRow;
  options: WizardOptions | null;
  busy: string | null;
  adsAvailable: boolean;
  adsReason?: string;
  onEdit: () => void;
  onCreateInMeta: () => void;
  onPause: () => void;
  onStop: () => void;
  onSync: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onReload: () => Promise<void>;
}) {
  const { d } = useI18n();
  const t = d.campaigns.card;
  const [confirmStop, setConfirmStop] = React.useState(false);
  const isBusy = (label: string) => busy === `${c.id}:${label}`;

  const statusLabel = (d.campaigns.statuses as Record<string, string>)[c.status] ?? c.status;
  const objectiveLabel = (d.campaigns.objectives as Record<string, string>)[c.objective] ?? c.objective;
  const ctaLabel = c.ctaType ? options?.ctaTypes.find((x) => x.value === c.ctaType)?.label ?? c.ctaType : null;
  const budgetLabel = c.dailyBudgetCents
    ? `${centsToMoney(c.dailyBudgetCents, c.currency)}${d.campaigns.perDayShort}`
    : `${centsToMoney(c.lifetimeBudgetCents, c.currency)} ${d.campaigns.wizard.lifetime.toLowerCase()}`;
  const local = c.status === "DRAFT" || c.status === "READY" || c.status === "ERROR";
  const inMeta = Boolean(c.metaCampaignId);
  const ins = c.insightsSnapshot;

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start gap-3">
          <CampaignThumb content={c.content} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold leading-6">{c.name}</span>
              <Badge tone={STATUS_TONE[c.status] ?? "default"}>{statusLabel}</Badge>
              {c.createdByAi && <Badge tone="accent"><Sparkles size={11} /> AI</Badge>}
              {inMeta && <Badge tone="info">{t.inMeta}</Badge>}
            </div>
            <p className="mt-0.5 truncate text-xs text-(--color-fg-muted)">
              {objectiveLabel} · {formatDate(c.createdAt)}
              {c.metaCampaignId && <span className="text-(--color-fg-faint)"> · #{c.metaCampaignId}</span>}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-sm font-bold tabular-nums">{budgetLabel}</div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-(--color-fg-faint)">{d.campaigns.budget}</div>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {ctaLabel && <FactChip label={d.campaigns.fields.cta} value={ctaLabel} />}
          {c.destinationUrl && (
            <a
              href={c.destinationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md bg-(--color-panel-2) px-2 py-1 text-[11px] leading-4 hover:bg-(--color-accent-soft) hover:text-(--color-accent)"
              title={c.destinationUrl}
            >
              <span className="text-(--color-fg-faint)">{d.campaigns.fields.destination}:</span>
              <span className="font-medium">{truncate(c.destinationUrl.replace(/^https?:\/\//, ""), 34)}</span>
              <ExternalLink size={11} />
            </a>
          )}
          {c.targeting && (
            <>
              <FactChip
                label={d.campaigns.fields.countries}
                value={[...(c.targeting.countries ?? []), ...(c.targeting.cities ?? []).map((x) => x.name ?? x.key)].join(", ") || "—"}
              />
              <FactChip label={d.campaigns.fields.age} value={`${c.targeting.ageMin ?? 18}–${c.targeting.ageMax ?? 65}`} />
              {c.targeting.genders?.length === 1 && (
                <FactChip label={d.campaigns.wizard.gender} value={c.targeting.genders[0] === 1 ? d.campaigns.wizard.genders.men : d.campaigns.wizard.genders.women} />
              )}
              {(c.targeting.interests?.length ?? 0) > 0 && (
                <FactChip label={d.campaigns.wizard.interests} value={(c.targeting.interests ?? []).map((i) => i.name ?? i.id).join(", ")} />
              )}
            </>
          )}
          {c.estimate && (
            <span className="inline-flex items-center gap-1 rounded-md bg-(--color-info-soft) px-2 py-1 text-[11px] leading-4 text-(--color-info)" title={d.campaigns.wizard.estimateNote}>
              <Users size={11} />
              {c.estimate.available
                ? d.campaigns.wizard.estimateRange(c.estimate.usersLowerBound.toLocaleString(), c.estimate.usersUpperBound.toLocaleString())
                : t.estimateUnavailable}
            </span>
          )}
          <span className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] leading-4 ${c._count.leads > 0 ? "bg-(--color-ok-soft) text-(--color-ok)" : "bg-(--color-panel-2)"}`}>
            <span className={c._count.leads > 0 ? "" : "text-(--color-fg-faint)"}>{d.nav.leads.split(" ")[0]}:</span>
            <span className="font-semibold tabular-nums">{c._count.leads}</span>
          </span>
        </div>

        {/* real numbers from Meta insights */}
        {inMeta && (
          <div className="rounded-lg border border-(--color-border) px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-(--color-fg-faint)">
              <span className="font-semibold uppercase tracking-wide">{t.live}</span>
              <span>{c.insightsSyncedAt ? `${t.synced} ${timeAgo(c.insightsSyncedAt)}` : t.notSynced}</span>
            </div>
            {ins ? (
              <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Metric label={t.spend} value={centsToMoney(Math.round(ins.spend * 100), ins.currency)} />
                <Metric label={t.impressions} value={ins.impressions.toLocaleString()} />
                <Metric label={t.reach} value={ins.reach.toLocaleString()} />
                <Metric label={t.clicks} value={ins.clicks.toLocaleString()} />
                <Metric label={t.results} value={ins.results === null ? "—" : ins.results.toLocaleString()} hint={ins.resultAction ?? undefined} />
              </div>
            ) : (
              <p className="mt-1 text-xs text-(--color-fg-muted)">{t.noDataYet}</p>
            )}
          </div>
        )}

        {c.lastError && (
          <div className="flex items-start gap-2 rounded-lg bg-(--color-danger-soft) px-3 py-2 text-[11px] leading-4 text-(--color-danger)">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{c.lastError}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-(--color-border) pt-3">
          {local && (
            <>
              <Button size="sm" variant="secondary" onClick={onEdit}>
                <PencilLine size={14} /> {d.campaigns.wizard.edit}
              </Button>
              <Button size="sm" variant="secondary" disabled={isBusy("meta") || !adsAvailable} title={!adsAvailable ? adsReason : undefined} onClick={onCreateInMeta}>
                <CloudUpload size={14} /> {d.campaigns.actions.createInMeta}
              </Button>
            </>
          )}
          {(c.status === "CREATED" || c.status === "PAUSED") && (
            <PublishDialog campaign={c} ctaLabel={ctaLabel} objectiveLabel={objectiveLabel} resume={c.status === "PAUSED"} onDone={onReload} />
          )}
          {c.status === "ACTIVE" && (
            <Button size="sm" variant="secondary" disabled={isBusy("pause")} onClick={onPause}>
              <PauseCircle size={14} /> {d.campaigns.actions.pause}
            </Button>
          )}
          {inMeta && c.status !== "ARCHIVED" && (
            <>
              {confirmStop ? (
                <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px] text-(--color-danger)">
                  {t.stopConfirm}
                  <Button size="sm" variant="danger" disabled={isBusy("stop")} onClick={() => { setConfirmStop(false); onStop(); }}>
                    <Square size={13} /> {t.stop}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmStop(false)}>
                    {d.common.cancel}
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="danger" disabled={isBusy("stop")} onClick={() => setConfirmStop(true)}>
                  <Square size={13} /> {t.stop}
                </Button>
              )}
            </>
          )}
          {inMeta && (
            <>
              <Button size="sm" variant="ghost" disabled={isBusy("sync")} onClick={onSync}>
                <RefreshCw size={14} className={isBusy("sync") ? "animate-spin" : undefined} /> {t.sync}
              </Button>
              <MetaPreviewDialog campaignId={c.id} disabled={!c.metaCreativeId} />
            </>
          )}
          {local && (
            <Button size="sm" variant="ghost" disabled={isBusy("delete")} onClick={onDelete}>
              <Trash2 size={14} /> {t.delete}
            </Button>
          )}
          {!local && c.status !== "ACTIVE" && c.status !== "ARCHIVED" && (
            <Button size="sm" variant="ghost" disabled={isBusy("archive")} onClick={onArchive}>
              <Archive size={14} /> {d.campaigns.actions.archive}
            </Button>
          )}
          {c.content?.permalink && (
            <Button asChild size="sm" variant="ghost" className="ml-auto">
              <a href={c.content.permalink} target="_blank" rel="noreferrer">
                <Instagram size={13} /> {d.common.open}
              </a>
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div title={hint}>
      <div className="text-[10px] uppercase tracking-wide text-(--color-fg-faint)">{label}</div>
      <div className="text-sm font-bold tabular-nums">{value}</div>
    </div>
  );
}

function CampaignThumb({ content }: { content: CampaignRow["content"] }) {
  const [ok, setOk] = React.useState(true);
  const src = content?.thumbnailUrl ?? content?.mediaUrl ?? null;
  if (src && ok) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt="" title={content?.caption ?? ""} className="h-12 w-12 shrink-0 rounded-lg object-cover" onError={() => setOk(false)} />
    );
  }
  return (
    <IconChip color="var(--color-mod-ads)" size={48}>
      {content ? <Film size={20} /> : <Megaphone size={20} />}
    </IconChip>
  );
}

function FactChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-(--color-panel-2) px-2 py-1 text-[11px] leading-4">
      <span className="text-(--color-fg-faint)">{label}:</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

/* ---------- Meta-rendered preview ---------- */

function MetaPreviewDialog({ campaignId, disabled }: { campaignId: string; disabled: boolean }) {
  const { d } = useI18n();
  const t = d.campaigns.card;
  const [open, setOpen] = React.useState(false);
  const [html, setHtml] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setLoading(true);
    api<{ html: string | null; reason: string | null }>(`/api/campaigns/${campaignId}/preview`, { silent: true })
      .then((res) => {
        setHtml(res.html);
        setReason(res.reason);
      })
      .catch(() => setReason(t.previewUnavailable))
      .finally(() => setLoading(false));
  }, [open, campaignId, t.previewUnavailable]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" disabled={disabled} title={disabled ? t.previewUnavailable : undefined} onClick={() => setOpen(true)}>
        <Eye size={14} /> {t.preview}
      </Button>
      <DialogContent title={t.previewTitle} description={t.previewFromMeta}>
        {loading ? (
          <p className="py-10 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>
        ) : html ? (
          <iframe title={t.previewTitle} srcDoc={html} sandbox="allow-scripts allow-same-origin" className="h-[560px] w-full rounded-lg border border-(--color-border) bg-white" />
        ) : (
          <p className="py-6 text-center text-sm text-(--color-fg-muted)">{reason ?? t.previewUnavailable}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ---------- start / resume (typed confirmation — spec §16: money never moves without it) ---------- */

function PublishDialog({
  campaign,
  ctaLabel,
  objectiveLabel,
  resume,
  onDone,
}: {
  campaign: CampaignRow;
  ctaLabel: string | null;
  objectiveLabel: string;
  resume: boolean;
  onDone: () => Promise<void>;
}) {
  const { d } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [confirmName, setConfirmName] = React.useState("");
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const budgetLabel = campaign.dailyBudgetCents
    ? `${centsToMoney(campaign.dailyBudgetCents, campaign.currency)}${d.campaigns.perDayShort}`
    : centsToMoney(campaign.lifetimeBudgetCents, campaign.currency);

  function openDialog(v: boolean) {
    setOpen(v);
    if (v) {
      setConfirmName("");
      setAck(false);
    }
  }

  async function publish() {
    setBusy(true);
    try {
      await api(`/api/campaigns/${campaign.id}/publish`, { method: "POST", json: { confirmName, acknowledgeSpend: true } });
      toast.success(d.campaigns.statuses.ACTIVE);
      setOpen(false);
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={openDialog}>
      <Button size="sm" onClick={() => openDialog(true)}>
        {resume ? <Play size={14} /> : <Rocket size={14} />} {resume ? d.campaigns.card.resume : d.campaigns.actions.publish}
      </Button>
      <DialogContent title={d.campaigns.publishConfirm.title}>
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-(--color-danger)/30 bg-(--color-danger-soft) p-3 text-xs leading-5">
            <p className="flex items-start gap-2 font-semibold text-(--color-danger)">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {d.campaigns.publishConfirm.text}
            </p>
            <div className="mt-2 space-y-0.5 text-(--color-fg)">
              <SummaryRow k={d.campaigns.fields.name} v={campaign.name} />
              <SummaryRow k={d.campaigns.objective} v={objectiveLabel} />
              <SummaryRow k={d.campaigns.budget} v={budgetLabel} />
              {ctaLabel && <SummaryRow k={d.campaigns.fields.cta} v={ctaLabel} />}
              {campaign.targeting && (
                <>
                  <SummaryRow k={d.campaigns.fields.countries} v={[...(campaign.targeting.countries ?? []), ...(campaign.targeting.cities ?? []).map((x) => x.name ?? x.key)].join(", ") || "—"} />
                  <SummaryRow k={d.campaigns.fields.age} v={`${campaign.targeting.ageMin ?? 18}–${campaign.targeting.ageMax ?? 65}`} />
                </>
              )}
            </div>
            <p className="mt-2 text-(--color-fg-muted)">{d.campaigns.wizard.metaSpendText}</p>
          </div>

          <Field label={d.campaigns.publishConfirm.typeName(campaign.name)}>
            <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={campaign.name} autoComplete="off" />
          </Field>

          <label className="flex cursor-pointer items-start gap-2 text-xs leading-5">
            <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            {d.campaigns.publishConfirm.ack}
          </label>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {d.common.cancel}
            </Button>
            <Button variant="danger" disabled={busy || !ack || confirmName.trim() !== campaign.name.trim()} onClick={publish}>
              <Rocket size={14} /> {d.campaigns.publishConfirm.confirm}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2">
      <span className="shrink-0 text-(--color-fg-muted)">{k}:</span>
      <span className="min-w-0 break-words font-medium">{v}</span>
    </div>
  );
}

// Lead Button hand-off keeps working: /campaigns?new=1&contentId=…&cta=…&url=…
void MousePointerClick;
