"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useAccounts } from "@/components/shell/account-context";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { centsToMoney, formatDate } from "@/lib/utils";

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

const STATUS_TONE: Record<string, "default" | "ok" | "warn" | "danger" | "accent"> = {
  DRAFT: "default",
  READY: "accent",
  CREATED: "warn",
  ACTIVE: "ok",
  PAUSED: "default",
  ERROR: "danger",
  ARCHIVED: "default",
};

export default function CampaignsPage() {
  return (
    <React.Suspense>
      <CampaignsInner />
    </React.Suspense>
  );
}

function CampaignsInner() {
  const { selected } = useAccounts();
  const [campaigns, setCampaigns] = React.useState<CampaignRow[] | null>(null);
  const [options, setOptions] = React.useState<Options | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);

  const adsCapability = selected?.capabilities.find((c) => c.key === "ads");

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
      toast.success("Created in Meta — everything is PAUSED. No money is being spent.");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function pause(c: CampaignRow) {
    setBusy(c.id);
    try {
      await api(`/api/campaigns/${c.id}/pause`, { method: "POST" });
      toast.success("Campaign paused");
      await load();
    } finally {
      setBusy(null);
    }
  }

  if (!selected) return <p className="text-sm text-[--color-fg-muted]">Connect an Instagram account first.</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Campaigns</h1>
          <p className="text-xs text-[--color-fg-muted]">
            Marketing API · everything is created PAUSED; activation always needs explicit confirmation.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New campaign draft</Button>
      </div>

      {adsCapability && !adsCapability.available && (
        <Card className="border-[--color-warn]/40">
          <CardBody className="flex items-start gap-3 text-sm">
            <Badge tone="warn">Campaigns unavailable for @{selected.username}</Badge>
            <p className="text-xs text-[--color-fg-muted]">{adsCapability.reason} Drafts can still be prepared and reviewed.</p>
          </CardBody>
        </Card>
      )}

      {campaigns?.length === 0 && (
        <Card>
          <CardBody className="py-10 text-center text-sm text-[--color-fg-muted]">No campaigns yet.</CardBody>
        </Card>
      )}

      {campaigns?.map((c) => (
        <Card key={c.id}>
          <CardHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                {c.name}
                <Badge tone={STATUS_TONE[c.status] ?? "default"}>{c.status}</Badge>
                {c.createdByAi && <Badge tone="accent">AI draft</Badge>}
              </span>
            }
            description={`${c.objective} · created ${formatDate(c.createdAt)}${c.metaCampaignId ? ` · Meta ID ${c.metaCampaignId}` : " · local draft only"}`}
          />
          <CardBody className="space-y-3">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
              <KV k="Daily budget" v={centsToMoney(c.dailyBudgetCents, c.currency)} />
              <KV k="Lifetime budget" v={centsToMoney(c.lifetimeBudgetCents, c.currency)} />
              <KV k="CTA" v={c.ctaType ?? "—"} />
              <KV k="Destination" v={c.destinationType ?? "—"} />
              <KV
                k="Audience"
                v={
                  c.targeting
                    ? `${(c.targeting.countries ?? ["US"]).join(", ")} · ${c.targeting.ageMin ?? 18}–${c.targeting.ageMax ?? 65}`
                    : "default"
                }
              />
              <KV k="Placements" v={(c.targeting?.instagramPositions ?? ["stream", "reels"]).join(", ")} />
              <KV k="Boosted content" v={c.content ? "yes" : "—"} />
              <KV k="Leads" v={String(c._count.leads)} />
            </div>
            {c.lastError && <p className="rounded bg-[--color-danger]/10 px-2 py-1 text-[11px] text-[--color-danger]">{c.lastError}</p>}
            <div className="flex flex-wrap gap-2 border-t border-[--color-border] pt-3">
              {(c.status === "DRAFT" || c.status === "READY" || c.status === "ERROR") && (
                <Button size="sm" variant="secondary" disabled={busy === c.id || !adsCapability?.available} onClick={() => createInMeta(c)}
                  title={!adsCapability?.available ? adsCapability?.reason : undefined}>
                  {busy === c.id ? "Creating…" : "Create in Meta (PAUSED)"}
                </Button>
              )}
              {(c.status === "CREATED" || c.status === "PAUSED") && <PublishDialog campaign={c} onDone={load} />}
              {c.status === "ACTIVE" && (
                <Button size="sm" variant="danger" disabled={busy === c.id} onClick={() => pause(c)}>
                  Pause (stop spending)
                </Button>
              )}
              {c.status !== "ACTIVE" && c.status !== "ARCHIVED" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await api(`/api/campaigns/${c.id}`, { method: "PATCH", json: { status: "ARCHIVED" } });
                    await load();
                  }}
                >
                  Archive
                </Button>
              )}
            </div>
          </CardBody>
        </Card>
      ))}

      {options && (
        <CreateCampaignDialog open={createOpen} onOpenChange={setCreateOpen} accountId={selected.id} options={options} onCreated={load} />
      )}
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <span className="text-[--color-fg-faint]">{k}</span>
      <div className="font-medium">{v}</div>
    </div>
  );
}

/** Spec §16: money never moves without typed confirmation. */
function PublishDialog({ campaign, onDone }: { campaign: CampaignRow; onDone: () => Promise<void> }) {
  const [open, setOpen] = React.useState(false);
  const [confirmName, setConfirmName] = React.useState("");
  const [ack, setAck] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const daily = campaign.dailyBudgetCents;
  const days =
    campaign.lifetimeBudgetCents || !daily
      ? null
      : 3; // display example horizon when only daily budget set
  const estimate = campaign.lifetimeBudgetCents
    ? centsToMoney(campaign.lifetimeBudgetCents, campaign.currency)
    : daily
      ? `${centsToMoney(daily, campaign.currency)}/day (${centsToMoney(daily * (days ?? 3), campaign.currency)} over ${days ?? 3} days)`
      : "unknown";

  async function publish() {
    setBusy(true);
    try {
      await api(`/api/campaigns/${campaign.id}/publish`, {
        method: "POST",
        json: { confirmName, acknowledgeSpend: true },
      });
      toast.success("Campaign is ACTIVE — Meta is now delivering ads and spending budget.");
      setOpen(false);
      await onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        Review & Publish…
      </Button>
      <DialogContent
        title="Publish campaign — real money"
        description="Activating sets campaign, ad set and ad to ACTIVE in Meta. Spending starts immediately."
      >
        <div className="space-y-3 text-sm">
          <div className="rounded-md border border-[--color-warn]/40 bg-[--color-warn]/10 p-3 text-xs leading-5">
            <div><b>Campaign:</b> {campaign.name}</div>
            <div><b>Objective:</b> {campaign.objective}</div>
            <div><b>Budget:</b> {estimate}</div>
            <div><b>CTA:</b> {campaign.ctaType ?? "—"}</div>
            <div>
              <b>Audience:</b>{" "}
              {campaign.targeting
                ? `${(campaign.targeting.countries ?? ["US"]).join(", ")}, age ${campaign.targeting.ageMin ?? 18}–${campaign.targeting.ageMax ?? 65}`
                : "default"}
            </div>
          </div>
          <Field label={`Type the campaign name to confirm: "${campaign.name}"`}>
            <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={campaign.name} />
          </Field>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I understand this campaign will spend real advertising budget.
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={busy || !ack || confirmName.trim() !== campaign.name.trim()} onClick={publish}>
              {busy ? "Publishing…" : "Publish & start spending"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateCampaignDialog({
  open,
  onOpenChange,
  accountId,
  options,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
  options: Options;
  onCreated: () => Promise<void>;
}) {
  const params = useSearchParams();
  const [name, setName] = React.useState("");
  const [objective, setObjective] = React.useState("OUTCOME_TRAFFIC");
  const [dailyBudget, setDailyBudget] = React.useState("5");
  const [countries, setCountries] = React.useState("UZ");
  const [ageMin, setAgeMin] = React.useState("18");
  const [ageMax, setAgeMax] = React.useState("35");
  const [ctaType, setCtaType] = React.useState("SIGN_UP");
  const [destinationUrl, setDestinationUrl] = React.useState("");
  const [message, setMessage] = React.useState("");
  const [contentId, setContentId] = React.useState<string>(params.get("contentId") ?? "");
  const [contentOptions, setContentOptions] = React.useState<Array<{ id: string; caption: string | null }>>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    if (params.get("contentId")) setContentId(params.get("contentId")!);
    api<{ items: Array<{ id: string; caption: string | null }> }>(`/api/content?accountId=${accountId}&take=50`, { silent: true })
      .then((d) => setContentOptions(d.items))
      .catch(() => undefined);
  }, [open, accountId, params]);

  React.useEffect(() => {
    if (params.get("contentId")) onOpenChange(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          creativeSpec: message ? { message } : null,
        },
      });
      toast.success("Draft created — review it, create in Meta (PAUSED), then publish when ready.");
      onOpenChange(false);
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide title="New campaign draft" description="Drafts are local. Nothing touches Meta until you click 'Create in Meta (PAUSED)'.">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <Field label="Campaign name" className="sm:col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Driving course — September signup" />
          </Field>
          <Field label="Objective">
            <Select value={objective} onChange={(e) => setObjective(e.target.value)}>
              {options.objectives.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Daily budget (USD)">
            <Input type="number" min="1" step="0.5" value={dailyBudget} onChange={(e) => setDailyBudget(e.target.value)} />
          </Field>
          <Field label="Countries (ISO codes, comma-separated)">
            <Input value={countries} onChange={(e) => setCountries(e.target.value)} placeholder="UZ, KZ" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Age min">
              <Input type="number" min="18" max="65" value={ageMin} onChange={(e) => setAgeMin(e.target.value)} />
            </Field>
            <Field label="Age max">
              <Input type="number" min="18" max="65" value={ageMax} onChange={(e) => setAgeMax(e.target.value)} />
            </Field>
          </div>
          <Field label="Native CTA button">
            <Select value={ctaType} onChange={(e) => setCtaType(e.target.value)}>
              {options.ctaTypes.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Destination URL (traffic objective)">
            <Input value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} placeholder="https://…" />
          </Field>
          <Field label="Boost existing content (source_instagram_media_id)" className="sm:col-span-2">
            <Select value={contentId} onChange={(e) => setContentId(e.target.value)}>
              <option value="">— none (link ad creative) —</option>
              {contentOptions.map((c) => (
                <option key={c.id} value={c.id}>
                  {(c.caption ?? c.id).slice(0, 80)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Ad text (for link ads)" className="sm:col-span-2">
            <Textarea rows={2} value={message} onChange={(e) => setMessage(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save draft"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
