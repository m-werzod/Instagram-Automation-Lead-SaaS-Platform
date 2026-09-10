"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useAccounts } from "@/components/shell/account-context";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { formatDate, truncate } from "@/lib/utils";

interface ContentRow {
  id: string;
  mediaId: string;
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
    recommendedObjective: string | null;
    recommendedCopy: string | null;
    topic: string | null;
    audience: string | null;
    reasoning: string | null;
    captionQuality: string | null;
  } | null;
  ctaConfigs: Array<{ id: string; name: string; kind: string; enabled: boolean }>;
  _count: { campaigns: number; leads: number };
}

export default function ContentPage() {
  const { selected } = useAccounts();
  const [items, setItems] = React.useState<ContentRow[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    if (!selected) return;
    const data = await api<{ items: ContentRow[] }>(`/api/content?accountId=${selected.id}`, { silent: true });
    setItems(data.items);
  }, [selected]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function sync() {
    if (!selected) return;
    setBusy("sync");
    try {
      const res = await api<{ synced: number }>(`/api/instagram/accounts/${selected.id}/sync`, { method: "POST" });
      toast.success(`Synced ${res.synced} media items from Instagram`);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function analyze(item: ContentRow) {
    setBusy(item.id);
    try {
      await api(`/api/content/${item.id}/analyze`, { method: "POST" });
      toast.success("AI analysis complete");
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function refreshInsights(item: ContentRow) {
    setBusy(item.id + ":ins");
    try {
      await api(`/api/content/${item.id}/insights`, { method: "POST" });
      await load();
      toast.success("Insights refreshed");
    } finally {
      setBusy(null);
    }
  }

  if (!selected) return <p className="text-sm text-[--color-fg-muted]">Connect an Instagram account first.</p>;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Content</h1>
          <p className="text-xs text-[--color-fg-muted]">
            Media retrieved via the official API for @{selected.username}. AI analysis reads caption + metadata (not
            video frames) and never launches anything by itself.
          </p>
        </div>
        <Button onClick={sync} disabled={busy === "sync"}>
          {busy === "sync" ? "Syncing…" : "Sync from Instagram"}
        </Button>
      </div>

      {items?.length === 0 && (
        <Card>
          <CardBody className="py-10 text-center text-sm text-[--color-fg-muted]">
            No content yet. Click &ldquo;Sync from Instagram&rdquo; to pull posts and Reels.
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {items?.map((item) => (
          <Card key={item.id}>
            <CardBody className="flex gap-3">
              <MediaThumb item={item} />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone="accent">{item.mediaProductType ?? item.mediaType}</Badge>
                  {item.isDemo && <Badge tone="warn">DEMO</Badge>}
                  <span className="text-[11px] text-[--color-fg-faint]">{formatDate(item.timestamp)}</span>
                </div>
                <p className="text-xs leading-5 text-[--color-fg-muted]">{truncate(item.caption, 140) || "(no caption)"}</p>
                <div className="flex flex-wrap gap-3 text-[11px] text-[--color-fg-faint]">
                  <span>♥ {item.likeCount ?? "—"}</span>
                  <span>💬 {item.commentsCount ?? "—"}</span>
                  {item.insights?.views !== undefined && <span>views {item.insights.views}</span>}
                  {item.insights?.reach !== undefined && <span>reach {item.insights.reach}</span>}
                  {item.permalink && (
                    <a className="text-[--color-accent] underline" href={item.permalink} target="_blank" rel="noreferrer">
                      open ↗
                    </a>
                  )}
                </div>

                {item.analysis && (
                  <div className="rounded-md border border-[--color-border] bg-[--color-panel-2] p-2 text-[11px] leading-4">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">AI analysis</span>
                      <Badge tone={item.analysis.leadPotential === "HIGH" ? "ok" : item.analysis.leadPotential === "MEDIUM" ? "warn" : "default"}>
                        Lead potential: {item.analysis.leadPotential}
                      </Badge>
                    </div>
                    <div className="mt-1 text-[--color-fg-muted]">
                      Suggested CTA: <b>{item.analysis.recommendedCta}</b> · Objective: <b>{item.analysis.recommendedObjective}</b>
                      <br />
                      {item.analysis.reasoning}
                    </div>
                  </div>
                )}

                {item.ctaConfigs.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {item.ctaConfigs.map((cta) => (
                      <Badge key={cta.id} tone={cta.enabled ? "ok" : "default"}>
                        CTA: {cta.name} ({cta.kind})
                      </Badge>
                    ))}
                  </div>
                )}

                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button size="sm" variant="secondary" onClick={() => analyze(item)} disabled={busy === item.id}>
                    {busy === item.id ? "Analyzing…" : item.analysis ? "Re-analyze" : "Analyze with AI"}
                  </Button>
                  {!item.isDemo && (
                    <Button size="sm" variant="ghost" onClick={() => refreshInsights(item)} disabled={busy === item.id + ":ins"}>
                      Insights
                    </Button>
                  )}
                  <CtaConfigDialog item={item} accountId={selected.id} onSaved={load} />
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/campaigns?contentId=${item.id}`}>Create campaign</Link>
                  </Button>
                </div>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}

function MediaThumb({ item }: { item: ContentRow }) {
  const src = item.thumbnailUrl ?? item.mediaUrl;
  return (
    <div className="grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-md border border-[--color-border] bg-[--color-panel-2] text-[10px] text-[--color-fg-faint]">
      {src ? (
        // Instagram CDN URLs expire; render best-effort without next/image optimization
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" />
      ) : (
        <span>{item.mediaProductType === "REELS" ? "REEL" : item.mediaType}</span>
      )}
    </div>
  );
}

function CtaConfigDialog({ item, accountId, onSaved }: { item: ContentRow; accountId: string; onSaved: () => Promise<void> }) {
  const [open, setOpen] = React.useState(false);
  const [kind, setKind] = React.useState<"MESSAGING" | "EXTERNAL_LINK" | "CREATIVE_OVERLAY" | "AD_NATIVE">("MESSAGING");
  const [name, setName] = React.useState("Sign-up CTA");
  const [flows, setFlows] = React.useState<Array<{ id: string; name: string }>>([]);
  const [flowId, setFlowId] = React.useState("");
  const [keyword, setKeyword] = React.useState("kurs");
  const [url, setUrl] = React.useState("");
  const [ctaType, setCtaType] = React.useState("SIGN_UP");
  const [overlayText, setOverlayText] = React.useState("SIGN UP — DM us \"kurs\"");
  const [overlayPos, setOverlayPos] = React.useState<"bottom" | "top" | "center">("bottom");
  const [nativeTypes, setNativeTypes] = React.useState<Array<{ value: string; label: string }>>([]);
  const [createLanding, setCreateLanding] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    api<{ flows: Array<{ id: string; name: string }> }>(`/api/lead-flows?accountId=${accountId}`, { silent: true })
      .then((d) => {
        setFlows(d.flows);
        if (d.flows[0]) setFlowId(d.flows[0].id);
      })
      .catch(() => undefined);
    api<{ nativeCtaTypes: Array<{ value: string; label: string }> }>(`/api/cta?accountId=${accountId}`, { silent: true })
      .then((d) => setNativeTypes(d.nativeCtaTypes))
      .catch(() => undefined);
  }, [open, accountId]);

  async function submit() {
    setBusy(true);
    try {
      await api("/api/cta", {
        method: "POST",
        json: {
          accountId,
          contentId: item.id,
          name,
          kind,
          ctaType: kind === "AD_NATIVE" ? ctaType : null,
          url: kind === "EXTERNAL_LINK" && !createLanding ? url : null,
          leadFlowId: kind === "AD_NATIVE" ? null : flowId || null,
          overlaySpec:
            kind === "CREATIVE_OVERLAY"
              ? { text: overlayText, position: overlayPos, bgColor: "#10b981", textColor: "#ffffff" }
              : null,
          messagingKeyword: kind === "MESSAGING" ? keyword : null,
          createLandingPage: kind === "EXTERNAL_LINK" && createLanding,
        },
      });
      toast.success("CTA configuration saved");
      setOpen(false);
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Configure CTA
      </Button>
      <DialogContent
        wide
        title="Configure CTA"
        description="Meta does not allow adding buttons to organic posts, or styling/repositioning native ad CTAs. Each option below is labeled with what it really is."
      >
        <div className="space-y-3">
          <Field label="CTA name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="MESSAGING">MESSAGING — keyword in DM/comment starts the lead flow (organic, free)</option>
              <option value="EXTERNAL_LINK">EXTERNAL LANDING PAGE — hosted form link for bio/caption</option>
              <option value="CREATIVE_OVERLAY">CREATIVE OVERLAY — visual CTA rendered into the creative (not a button)</option>
              <option value="AD_NATIVE">NATIVE META CTA — real ad button (requires Facebook-Login mode + campaign)</option>
            </Select>
          </Field>

          {kind === "MESSAGING" && (
            <>
              <Field label="Trigger keyword" hint='User DMs this word → the lead flow starts (e.g. caption says: DM "kurs")'>
                <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} />
              </Field>
              <FlowSelect flows={flows} value={flowId} onChange={setFlowId} />
            </>
          )}
          {kind === "EXTERNAL_LINK" && (
            <>
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={createLanding} onChange={(e) => setCreateLanding(e.target.checked)} />
                Host a landing page on this platform (form is built from the lead flow)
              </label>
              {createLanding ? (
                <FlowSelect flows={flows} value={flowId} onChange={setFlowId} />
              ) : (
                <Field label="External URL">
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
                </Field>
              )}
            </>
          )}
          {kind === "CREATIVE_OVERLAY" && (
            <>
              <Field label="Overlay text (burned into the creative before publishing — this is a visual element, NOT a clickable button)">
                <Input value={overlayText} onChange={(e) => setOverlayText(e.target.value)} maxLength={60} />
              </Field>
              <Field label="Position">
                <Select value={overlayPos} onChange={(e) => setOverlayPos(e.target.value as typeof overlayPos)}>
                  <option value="bottom">Below / bottom of video</option>
                  <option value="top">Top of video</option>
                  <option value="center">Center</option>
                </Select>
              </Field>
            </>
          )}
          {kind === "AD_NATIVE" && (
            <>
              <Field
                label="Native CTA button type (fixed position & style — Meta renders it, we cannot move or recolor it)"
                hint="Applied when you promote this post via Campaigns. Requires Facebook-Login connection mode."
              >
                <Select value={ctaType} onChange={(e) => setCtaType(e.target.value)}>
                  {nativeTypes.map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label} ({t.value})
                    </option>
                  ))}
                </Select>
              </Field>
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={busy}>
              {busy ? "Saving…" : "Save CTA"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FlowSelect({ flows, value, onChange }: { flows: Array<{ id: string; name: string }>; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Lead flow">
      {flows.length === 0 ? (
        <p className="text-xs text-[--color-warn]">
          No lead flows yet — create one under CRM · Lead Flows first.
        </p>
      ) : (
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
          {flows.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}
