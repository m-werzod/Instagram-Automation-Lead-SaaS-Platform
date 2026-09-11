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
  Film,
  Instagram,
  Megaphone,
  MousePointerClick,
  PauseCircle,
  PencilLine,
  Plus,
  Rocket,
  Sparkles,
} from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { useAccounts } from "@/components/shell/account-context";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Card, CardBody, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { centsToMoney, formatDate, truncate } from "@/lib/utils";

/**
 * Ad Campaigns — the only screen where real money can move, so the lifecycle
 * is deliberately slow: local DRAFT → created PAUSED in Meta → typed-name
 * confirmation before anything spends. The Lead Button page deep-links here
 * (?new=1&contentId&cta&url) to prefill a traffic campaign for its landing page.
 */

interface CampaignRow {
  id: string;
  name: string;
  objective: string;
  status: string;
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
  currency: string;
  ctaType: string | null;
  destinationType: string | null;
  destinationUrl: string | null;
  targeting: { countries?: string[]; ageMin?: number; ageMax?: number; genders?: number[]; instagramPositions?: string[] } | null;
  createdByAi: boolean;
  metaCampaignId: string | null;
  lastError: string | null;
  createdAt: string;
  publishedAt: string | null;
  content: { id: string; caption: string | null; thumbnailUrl: string | null } | null;
  account: { username: string; connectionMode: string; adAccountId: string | null };
  _count: { leads: number };
}

interface Options {
  objectives: Array<{ value: string; label: string }>;
  ctaTypes: Array<{ value: string; label: string }>;
}

interface ContentOption {
  id: string;
  caption: string | null;
}

/** Values carried over from the Lead Button page (or a plain ?contentId deep link). */
interface Prefill {
  fromLeadButton: boolean;
  contentId: string;
  ctaType: string | null;
  destinationUrl: string;
}

/** Spec: DRAFT=default READY=info CREATED=warn ACTIVE=ok PAUSED=warn ARCHIVED=default ERROR=danger */
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
  // useSearchParams (Lead Button prefill) requires a Suspense boundary.
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
  const [options, setOptions] = React.useState<Options | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const adsCapability = selected?.capabilities.find((c) => c.key === "ads");

  /** Lead Button hand-off: /campaigns?new=1&contentId=…&cta=…&url=… (a bare ?contentId also opens the dialog). */
  const prefill = React.useMemo<Prefill | null>(() => {
    const fromLeadButton = params.get("new") === "1";
    const contentId = params.get("contentId") ?? "";
    if (!fromLeadButton && !contentId) return null;
    return {
      fromLeadButton,
      contentId,
      ctaType: params.get("cta"),
      destinationUrl: params.get("url") ?? "",
    };
  }, [params]);

  const autoOpened = React.useRef(false);
  React.useEffect(() => {
    if (prefill && !autoOpened.current) {
      autoOpened.current = true;
      setCreateOpen(true);
    }
  }, [prefill]);

  const load = React.useCallback(async () => {
    if (!selected) return;
    const data = await api<{ campaigns: CampaignRow[]; options: Options }>(`/api/campaigns?accountId=${selected.id}`, { silent: true });
    setCampaigns(data.campaigns);
    setOptions(data.options);
  }, [selected]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function createInMeta(c: CampaignRow) {
    setBusy(c.id);
    try {
      await api(`/api/campaigns/${c.id}/create-in-meta`, { method: "POST" });
      toast.success(d.campaigns.statuses.CREATED);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function pause(c: CampaignRow) {
    setBusy(c.id);
    try {
      await api(`/api/campaigns/${c.id}/pause`, { method: "POST" });
      toast.success(d.campaigns.statuses.PAUSED);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function archive(c: CampaignRow) {
    setBusy(c.id);
    try {
      await api(`/api/campaigns/${c.id}`, { method: "PATCH", json: { status: "ARCHIVED" } });
      await load();
    } finally {
      setBusy(null);
    }
  }

  /* ---------- guards ---------- */

  if (accountsLoading || (selected && campaigns === null)) {
    return <div className="py-20 text-center text-sm text-[--color-fg-muted]">{d.common.loading}</div>;
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
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> {d.campaigns.create}
          </Button>
        }
      />

      {/* No ad account connected — campaigns can be drafted but never reach Meta. */}
      {!selected.adAccountId && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[--color-warn]/30 bg-[--color-warn-soft] px-4 py-3 text-xs leading-5 text-[--color-warn]">
          <AlertTriangle size={14} className="shrink-0" />
          <span className="font-medium">{d.campaigns.needsAds}</span>
          <Link href="/instagram" className="font-semibold underline underline-offset-2">
            {d.nav.instagram} →
          </Link>
        </div>
      )}

      {/* The money-safety ladder, told with the status labels themselves. */}
      <Card className="overflow-hidden">
        <CardBody className="flex flex-wrap items-center justify-between gap-3 py-3">
          <FlowStep n={1} color="var(--color-fg-muted)" icon={<PencilLine size={15} />} label={d.campaigns.statuses.DRAFT} />
          <ArrowRight size={14} className="hidden shrink-0 text-[--color-fg-faint] md:block" />
          <FlowStep n={2} color="var(--color-mod-ads)" icon={<PauseCircle size={15} />} label={d.campaigns.statuses.CREATED} />
          <ArrowRight size={14} className="hidden shrink-0 text-[--color-fg-faint] md:block" />
          <FlowStep n={3} color="var(--color-ok)" icon={<Rocket size={15} />} label={d.campaigns.statuses.ACTIVE} />
        </CardBody>
      </Card>

      {campaigns?.length === 0 && (
        <EmptyState
          icon={<IconChip color="var(--color-mod-ads)" size={48}><Megaphone size={22} /></IconChip>}
          title={d.campaigns.empty}
          action={
            <Button onClick={() => setCreateOpen(true)}>
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
          busy={busy === c.id}
          adsAvailable={Boolean(adsCapability?.available)}
          adsReason={adsCapability?.reason}
          onCreateInMeta={() => createInMeta(c)}
          onPause={() => pause(c)}
          onArchive={() => archive(c)}
          onReload={load}
        />
      ))}

      {options && (
        <CreateCampaignDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          accountId={selected.id}
          options={options}
          prefill={prefill}
          onCreated={load}
        />
      )}
    </div>
  );
}

/* ---------- lifecycle strip ---------- */

function FlowStep({ n, color, icon, label }: { n: number; color: string; icon: React.ReactNode; label: string }) {
  return (
    <div className="flex min-w-0 flex-1 basis-40 items-center gap-2.5">
      <IconChip color={color} size={34}>{icon}</IconChip>
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wide text-[--color-fg-faint]">{n}</div>
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
  onCreateInMeta,
  onPause,
  onArchive,
  onReload,
}: {
  c: CampaignRow;
  options: Options | null;
  busy: boolean;
  adsAvailable: boolean;
  adsReason?: string;
  onCreateInMeta: () => void;
  onPause: () => void;
  onArchive: () => void;
  onReload: () => Promise<void>;
}) {
  const { d } = useI18n();

  const statusLabel = (d.campaigns.statuses as Record<string, string>)[c.status] ?? c.status;
  const objectiveLabel = (d.campaigns.objectives as Record<string, string>)[c.objective] ?? c.objective;
  const ctaLabel = c.ctaType ? options?.ctaTypes.find((t) => t.value === c.ctaType)?.label ?? c.ctaType : null;
  const budgetLabel = c.dailyBudgetCents
    ? `${centsToMoney(c.dailyBudgetCents, c.currency)}${d.campaigns.perDayShort}`
    : centsToMoney(c.lifetimeBudgetCents, c.currency);
  const leadsWord = d.nav.leads.split(" ")[0];

  return (
    <Card>
      <CardBody className="space-y-3">
        <div className="flex items-start gap-3">
          <CampaignThumb content={c.content} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-semibold leading-6">{c.name}</span>
              <Badge tone={STATUS_TONE[c.status] ?? "default"}>{statusLabel}</Badge>
              {c.createdByAi && (
                <Badge tone="accent"><Sparkles size={11} /> AI</Badge>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-[--color-fg-muted]">
              {objectiveLabel} · {formatDate(c.createdAt)}
              {c.metaCampaignId && <span className="text-[--color-fg-faint]"> · #{c.metaCampaignId}</span>}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-sm font-bold tabular-nums">{budgetLabel}</div>
            <div className="text-[10px] font-medium uppercase tracking-wide text-[--color-fg-faint]">{d.campaigns.budget}</div>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {ctaLabel && <FactChip label={d.campaigns.fields.cta} value={ctaLabel} />}
          {c.destinationUrl && (
            <a
              href={c.destinationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md bg-[--color-panel-2] px-2 py-1 text-[11px] leading-4 hover:bg-[--color-accent-soft] hover:text-[--color-accent]"
              title={c.destinationUrl}
            >
              <span className="text-[--color-fg-faint]">{d.campaigns.fields.destination}:</span>
              <span className="font-medium">{truncate(c.destinationUrl.replace(/^https?:\/\//, ""), 34)}</span>
              <ExternalLink size={11} />
            </a>
          )}
          {c.targeting && (
            <>
              <FactChip label={d.campaigns.fields.countries} value={(c.targeting.countries ?? []).join(", ") || "—"} />
              <FactChip label={d.campaigns.fields.age} value={`${c.targeting.ageMin ?? 18}–${c.targeting.ageMax ?? 65}`} />
            </>
          )}
          <span
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] leading-4 ${
              c._count.leads > 0 ? "bg-[--color-ok-soft] text-[--color-ok]" : "bg-[--color-panel-2]"
            }`}
          >
            <span className={c._count.leads > 0 ? "" : "text-[--color-fg-faint]"}>{leadsWord}:</span>
            <span className="font-semibold tabular-nums">{c._count.leads}</span>
          </span>
        </div>

        {c.lastError && (
          <div className="flex items-start gap-2 rounded-lg bg-[--color-danger-soft] px-3 py-2 text-[11px] leading-4 text-[--color-danger]">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            <span className="min-w-0 break-words">{c.lastError}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-[--color-border] pt-3">
          {(c.status === "DRAFT" || c.status === "READY" || c.status === "ERROR") && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !adsAvailable}
              title={!adsAvailable ? adsReason : undefined}
              onClick={onCreateInMeta}
            >
              <CloudUpload size={14} /> {d.campaigns.actions.createInMeta}
            </Button>
          )}
          {(c.status === "CREATED" || c.status === "PAUSED") && (
            <PublishDialog campaign={c} ctaLabel={ctaLabel} objectiveLabel={objectiveLabel} onDone={onReload} />
          )}
          {c.status === "ACTIVE" && (
            <Button size="sm" variant="danger" disabled={busy} onClick={onPause}>
              <PauseCircle size={14} /> {d.campaigns.actions.pause}
            </Button>
          )}
          {c.status !== "ACTIVE" && c.status !== "ARCHIVED" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onArchive}>
              <Archive size={14} /> {d.campaigns.actions.archive}
            </Button>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function CampaignThumb({ content }: { content: CampaignRow["content"] }) {
  const [ok, setOk] = React.useState(true);
  if (content?.thumbnailUrl && ok) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={content.thumbnailUrl}
        alt=""
        title={content.caption ?? ""}
        className="h-12 w-12 shrink-0 rounded-lg object-cover"
        onError={() => setOk(false)}
      />
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
    <span className="inline-flex items-center gap-1 rounded-md bg-[--color-panel-2] px-2 py-1 text-[11px] leading-4">
      <span className="text-[--color-fg-faint]">{label}:</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}

/* ---------- publish (typed confirmation — spec §16: money never moves without it) ---------- */

function PublishDialog({
  campaign,
  ctaLabel,
  objectiveLabel,
  onDone,
}: {
  campaign: CampaignRow;
  ctaLabel: string | null;
  objectiveLabel: string;
  onDone: () => Promise<void>;
}) {
  const { d } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [confirmName, setConfirmName] = React.useState("");
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  // Only the daily budget is shown — no invented multi-day cost projections.
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
      await api(`/api/campaigns/${campaign.id}/publish`, {
        method: "POST",
        json: { confirmName, acknowledgeSpend: true },
      });
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
        <Rocket size={14} /> {d.campaigns.actions.publish}
      </Button>
      <DialogContent title={d.campaigns.publishConfirm.title}>
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-[--color-danger]/30 bg-[--color-danger-soft] p-3 text-xs leading-5">
            <p className="flex items-start gap-2 font-semibold text-[--color-danger]">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              {d.campaigns.publishConfirm.text}
            </p>
            <div className="mt-2 space-y-0.5 text-[--color-fg]">
              <SummaryRow k={d.campaigns.fields.name} v={campaign.name} />
              <SummaryRow k={d.campaigns.objective} v={objectiveLabel} />
              <SummaryRow k={d.campaigns.budget} v={budgetLabel} />
              {ctaLabel && <SummaryRow k={d.campaigns.fields.cta} v={ctaLabel} />}
              {campaign.targeting && (
                <>
                  <SummaryRow k={d.campaigns.fields.countries} v={(campaign.targeting.countries ?? []).join(", ") || "—"} />
                  <SummaryRow k={d.campaigns.fields.age} v={`${campaign.targeting.ageMin ?? 18}–${campaign.targeting.ageMax ?? 65}`} />
                </>
              )}
            </div>
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
            <Button
              variant="danger"
              disabled={busy || !ack || confirmName.trim() !== campaign.name.trim()}
              onClick={publish}
            >
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
      <span className="shrink-0 text-[--color-fg-muted]">{k}:</span>
      <span className="min-w-0 break-words font-medium">{v}</span>
    </div>
  );
}

/* ---------- create draft ---------- */

function CreateCampaignDialog({
  open,
  onOpenChange,
  accountId,
  options,
  prefill,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
  options: Options;
  prefill: Prefill | null;
  onCreated: () => Promise<void>;
}) {
  const { d } = useI18n();
  const [name, setName] = React.useState("");
  const [objective, setObjective] = React.useState("OUTCOME_TRAFFIC");
  const [dailyBudget, setDailyBudget] = React.useState("5");
  const [countries, setCountries] = React.useState("UZ");
  const [ageMin, setAgeMin] = React.useState("18");
  const [ageMax, setAgeMax] = React.useState("35");
  const [ctaType, setCtaType] = React.useState(prefill?.ctaType ?? "SIGN_UP");
  const [destinationUrl, setDestinationUrl] = React.useState(prefill?.destinationUrl ?? "");
  const [contentId, setContentId] = React.useState(prefill?.contentId ?? "");
  const [contentOptions, setContentOptions] = React.useState<ContentOption[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    api<{ items: ContentOption[] }>(`/api/content?accountId=${accountId}&take=50`, { silent: true })
      .then((res) => setContentOptions(res.items))
      .catch(() => undefined);
  }, [open, accountId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const dailyCents = Math.round(Number(dailyBudget) * 100);
      await api("/api/campaigns", {
        method: "POST",
        json: {
          accountId,
          name,
          objective,
          dailyBudgetCents: Number.isFinite(dailyCents) && dailyCents >= 100 ? dailyCents : null,
          targeting: {
            countries: countries.split(",").map((c) => c.trim().toUpperCase()).filter((c) => c.length === 2),
            ageMin: Number(ageMin) || 18,
            ageMax: Number(ageMax) || 65,
            instagramPositions: ["stream", "reels"],
          },
          ctaType,
          destinationType: objective === "OUTCOME_TRAFFIC" ? "WEBSITE" : objective === "OUTCOME_ENGAGEMENT" ? "INSTAGRAM_DIRECT" : null,
          destinationUrl: destinationUrl || null,
          contentId: contentId || null,
        },
      });
      toast.success(d.common.saved);
      onOpenChange(false);
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide title={d.campaigns.create} description={d.campaigns.subtitle}>
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          {prefill?.fromLeadButton && (
            <div className="flex items-start gap-2 rounded-lg bg-[--color-accent-soft] px-3 py-2.5 text-xs leading-5 text-[--color-accent] sm:col-span-2">
              <MousePointerClick size={14} className="mt-0.5 shrink-0" />
              <span>{d.campaigns.leadButtonBanner}</span>
            </div>
          )}

          <Field label={d.campaigns.fields.name} className="sm:col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={150} />
          </Field>

          <Field label={d.campaigns.objective}>
            <Select value={objective} onChange={(e) => setObjective(e.target.value)}>
              {options.objectives.map((o) => (
                <option key={o.value} value={o.value}>
                  {(d.campaigns.objectives as Record<string, string>)[o.value] ?? o.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={d.campaigns.fields.dailyBudget}>
            <Input type="number" min="1" step="0.5" value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} />
          </Field>

          <Field label={d.campaigns.fields.countries}>
            <Input value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="UZ, KZ" />
          </Field>

          <Field label={d.campaigns.fields.age}>
            <div className="flex items-center gap-2">
              <Input type="number" min="18" max="65" value={ageMin} onChange={(e) => setAgeMin(e.target.value)} aria-label={`${d.campaigns.fields.age} min`} />
              <span className="shrink-0 text-xs text-[--color-fg-faint]">–</span>
              <Input type="number" min="18" max="65" value={ageMax} onChange={(e) => setAgeMax(e.target.value)} aria-label={`${d.campaigns.fields.age} max`} />
            </div>
          </Field>

          <Field label={d.campaigns.fields.cta}>
            <Select value={ctaType} onChange={(e) => setCtaType(e.target.value)}>
              {options.ctaTypes.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={d.campaigns.fields.destination}>
            <Input value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} placeholder="https://…" />
          </Field>

          <Field label={d.campaigns.fields.content} className="sm:col-span-2">
            <Select value={contentId} onChange={(e) => setContentId(e.target.value)}>
              <option value="">— {d.common.none} —</option>
              {contentOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {truncate(c.caption ?? c.id, 80)}
                </option>
              ))}
            </Select>
          </Field>

          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {d.common.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? d.common.saving : d.common.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
