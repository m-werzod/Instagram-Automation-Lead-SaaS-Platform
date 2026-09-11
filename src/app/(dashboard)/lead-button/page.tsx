"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Film,
  MousePointerClick,
  MessageCircleQuestion,
  UserCheck,
  ArrowRight,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Copy,
  ExternalLink,
  Link2,
  KeyRound,
  Megaphone,
  X,
  Instagram,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { useAccounts } from "@/components/shell/account-context";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Segmented, Select } from "@/components/ui/input";
import { ToggleRow } from "@/components/ui/switch";
import { PhonePreview } from "@/components/lead-button/phone-preview";
import { QuestionEditor } from "@/components/lead-button/question-editor";
import { DEFAULT_BUTTON_SPEC, type ButtonSpec } from "@/lib/validation/leadbutton";
import type { QuestionInput } from "@/lib/validation/leadflow";
import type { Dictionary } from "@/lib/i18n/dictionaries";

/**
 * Lead Button builder — THE core screen of the platform.
 * Left: a phone showing exactly what the customer sees. Right: the controls.
 * Everything saves atomically through /api/lead-button.
 */

interface ContentItemLite {
  id: string;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  mediaProductType: string | null;
  mediaType: string;
}

interface LeadButtonDto {
  id: string;
  enabled: boolean;
  landingSlug: string | null;
  landingUrl: string | null;
  contentId: string | null;
  content: ContentItemLite | null;
  ctaType: string | null;
  buttonSpec: ButtonSpec;
  headline: string;
  description: string | null;
  completionMessage: string | null;
  triggerKeywords: string[];
  flowId: string;
  questions: Array<QuestionInput & { id: string; order: number }>;
  leadsCount: number;
}

interface Draft {
  enabled: boolean;
  headline: string;
  description: string;
  completionMessage: string;
  buttonSpec: ButtonSpec;
  contentId: string | null;
  ctaType: string | null;
  triggerKeywords: string[];
  questions: QuestionInput[];
}

function starterDraft(d: Dictionary): Draft {
  return {
    enabled: true,
    headline: d.leadButton.starter.headline,
    description: "",
    completionMessage: d.leadButton.starter.completion,
    buttonSpec: { ...DEFAULT_BUTTON_SPEC, label: d.leadButton.starter.buttonLabel },
    contentId: null,
    ctaType: "SIGN_UP",
    triggerKeywords: [],
    questions: [
      { title: d.leadButton.starter.q1Title, prompt: d.leadButton.starter.q1Prompt, type: "TEXT", required: true, options: [], mapTo: "name", validationRegex: null },
      { title: d.leadButton.starter.q2Title, prompt: d.leadButton.starter.q2Prompt, type: "PHONE", required: true, options: [], mapTo: "phone", validationRegex: null },
    ],
  };
}

function draftFrom(lb: LeadButtonDto): Draft {
  return {
    enabled: lb.enabled,
    headline: lb.headline,
    description: lb.description ?? "",
    completionMessage: lb.completionMessage ?? "",
    buttonSpec: lb.buttonSpec,
    contentId: lb.contentId,
    ctaType: lb.ctaType,
    triggerKeywords: lb.triggerKeywords,
    questions: lb.questions.map((q) => ({
      title: q.title,
      prompt: q.prompt,
      type: q.type,
      required: q.required,
      options: q.options,
      mapTo: q.mapTo ?? null,
      validationRegex: q.validationRegex ?? null,
    })),
  };
}

const COLOR_PRESETS: Array<Pick<ButtonSpec, "bg" | "fg" | "border">> = [
  { bg: "#4f46e5", fg: "#ffffff", border: null },
  { bg: "#16a34a", fg: "#ffffff", border: null },
  { bg: "#db2777", fg: "#ffffff", border: null },
  { bg: "#f59e0b", fg: "#111827", border: null },
  { bg: "#0095f6", fg: "#ffffff", border: null },
  { bg: "#111827", fg: "#ffffff", border: null },
  { bg: "#ffffff", fg: "#111827", border: "#111827" },
];

export default function LeadButtonPage() {
  const { d } = useI18n();
  const { selected, loading: accountsLoading } = useAccounts();

  const [leadButton, setLeadButton] = React.useState<LeadButtonDto | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [baseline, setBaseline] = React.useState<string>("");
  const [nativeCtaTypes, setNativeCtaTypes] = React.useState<Array<{ value: string; label: string }>>([]);
  const [adsReady, setAdsReady] = React.useState(false);
  const [reels, setReels] = React.useState<ContentItemLite[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editIndex, setEditIndex] = React.useState<number | null>(null);
  const [keywordInput, setKeywordInput] = React.useState("");

  const dirty = draft !== null && JSON.stringify(draft) !== baseline;

  const load = React.useCallback(async () => {
    if (!selected) return;
    setLoading(true);
    try {
      const [lbRes, contentRes] = await Promise.all([
        api<{ leadButton: LeadButtonDto | null; nativeCtaTypes: Array<{ value: string; label: string }>; adsReady: boolean }>(
          `/api/lead-button?accountId=${selected.id}`,
        ),
        api<{ items: ContentItemLite[] }>(`/api/content?accountId=${selected.id}&take=60`, { silent: true }).catch(() => ({ items: [] as ContentItemLite[] })),
      ]);
      setLeadButton(lbRes.leadButton);
      setNativeCtaTypes(lbRes.nativeCtaTypes);
      setAdsReady(lbRes.adsReady);
      const next = lbRes.leadButton ? draftFrom(lbRes.leadButton) : starterDraft(d);
      setDraft(next);
      // A brand-new (unsaved) Lead Button must start dirty so the first
      // "Save" is enabled without requiring a cosmetic change first.
      setBaseline(lbRes.leadButton ? JSON.stringify(next) : "");
      const vids = contentRes.items.filter((i) => i.mediaProductType === "REELS" || i.mediaType === "VIDEO");
      setReels(vids.length ? vids : contentRes.items);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  function patch(p: Partial<Draft>) {
    setDraft((prev) => (prev ? { ...prev, ...p } : prev));
  }
  function patchSpec(p: Partial<ButtonSpec>) {
    setDraft((prev) => (prev ? { ...prev, buttonSpec: { ...prev.buttonSpec, ...p } } : prev));
  }

  async function save() {
    if (!selected || !draft) return;
    if (!draft.headline.trim()) return toast.error(d.leadButton.validation.needHeadline);
    if (!draft.buttonSpec.label.trim()) return toast.error(d.leadButton.validation.needLabel);
    if (draft.questions.length === 0) return toast.error(d.leadButton.validation.needQuestion);
    setSaving(true);
    try {
      const res = await api<{ leadButton: LeadButtonDto }>("/api/lead-button", {
        method: "PUT",
        json: {
          accountId: selected.id,
          enabled: draft.enabled,
          headline: draft.headline.trim(),
          description: draft.description.trim() || null,
          completionMessage: draft.completionMessage.trim() || null,
          buttonSpec: draft.buttonSpec,
          contentId: draft.contentId,
          ctaType: draft.ctaType,
          triggerKeywords: draft.triggerKeywords,
          questions: draft.questions,
        },
      });
      setLeadButton(res.leadButton);
      const next = draftFrom(res.leadButton);
      setDraft(next);
      setBaseline(JSON.stringify(next));
      toast.success(d.leadButton.savedOk);
    } catch {
      /* toast shown by api() */
    } finally {
      setSaving(false);
    }
  }

  /* ---------- guards ---------- */

  if (accountsLoading || (selected && loading)) {
    return <div className="py-20 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</div>;
  }

  if (!selected) {
    return (
      <>
        <PageHeader title={d.leadButton.title} description={d.leadButton.subtitle} accent="var(--color-accent)" />
        <EmptyState
          icon={<IconChip color="var(--color-mod-instagram)" size={48}><Instagram size={22} /></IconChip>}
          title={d.leadButton.notReady}
          action={
            <Button asChild variant="instagram">
              <Link href="/instagram">{d.leadButton.goConnect}</Link>
            </Button>
          }
        />
      </>
    );
  }
  if (!draft) return null;

  const selectedReel = draft.contentId ? reels.find((r) => r.id === draft.contentId) ?? leadButton?.content ?? null : null;
  const ctaLabel = nativeCtaTypes.find((c) => c.value === draft.ctaType)?.label ?? draft.buttonSpec.label;

  return (
    <>
      <PageHeader
        title={d.leadButton.title}
        description={d.leadButton.subtitle}
        accent="var(--color-accent)"
        actions={
          <div className="flex items-center gap-2">
            {dirty && <Badge tone="warn">{d.leadButton.unsaved}</Badge>}
            {leadButton && <Badge tone="ok">{d.leadButton.questionsB.count(draft.questions.length)} · {leadButton.leadsCount} {d.nav.leads.split(" ")[0]}</Badge>}
            <Button onClick={save} disabled={saving || !dirty}>
              {saving ? d.common.saving : d.leadButton.saveButton}
            </Button>
          </div>
        }
      />

      {/* How it works — visual, 4 steps */}
      <Card className="mb-5 overflow-hidden">
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <HowStep icon={<Film size={16} />} color="var(--color-mod-content)" n={1} text={d.leadButton.how1} />
          <ArrowRight size={14} className="hidden shrink-0 text-(--color-fg-faint) md:block" />
          <HowStep icon={<MousePointerClick size={16} />} color="var(--color-accent)" n={2} text={d.leadButton.how2} />
          <ArrowRight size={14} className="hidden shrink-0 text-(--color-fg-faint) md:block" />
          <HowStep icon={<MessageCircleQuestion size={16} />} color="var(--color-mod-ai)" n={3} text={d.leadButton.how3} />
          <ArrowRight size={14} className="hidden shrink-0 text-(--color-fg-faint) md:block" />
          <HowStep icon={<UserCheck size={16} />} color="var(--color-mod-leads)" n={4} text={d.leadButton.how4} />
        </CardBody>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
        {/* LEFT: live phone preview */}
        <div className="lg:sticky lg:top-0 lg:self-start">
          <h2 className="mb-3 text-center text-xs font-semibold uppercase tracking-wide text-(--color-fg-muted)">
            {d.leadButton.preview.title}
          </h2>
          <PhonePreview
            spec={draft.buttonSpec}
            headline={draft.headline}
            description={draft.description}
            completionMessage={draft.completionMessage}
            questions={draft.questions.map((q) => ({ title: q.title, prompt: q.prompt, type: q.type, required: q.required, options: q.options }))}
            ctaLabel={ctaLabel}
            reelThumb={selectedReel?.thumbnailUrl ?? selectedReel?.mediaUrl ?? null}
            reelCaption={selectedReel?.caption ?? null}
            username={selected.username}
          />
        </div>

        {/* RIGHT: configuration */}
        <div className="min-w-0 space-y-5">
          {/* enable */}
          <Card>
            <CardBody className="py-1">
              <ToggleRow
                label={draft.enabled ? d.leadButton.enable : d.leadButton.disable}
                description={d.leadButton.subtitle}
                checked={draft.enabled}
                onCheckedChange={(v) => patch({ enabled: v })}
                onLabel={d.common.on}
                offLabel={d.common.off}
              />
            </CardBody>
          </Card>

          {/* target */}
          <Card>
            <CardHeader
              icon={<IconChip color="var(--color-mod-content)"><Film size={16} /></IconChip>}
              title={d.leadButton.sections.target}
            />
            <CardBody className="space-y-3">
              <Segmented
                value={draft.contentId === null ? "all" : "one"}
                onChange={(v) => patch({ contentId: v === "all" ? null : (reels[0]?.id ?? null) })}
                options={[
                  { value: "all", label: d.leadButton.target.all, title: d.leadButton.target.allHint },
                  { value: "one", label: d.leadButton.target.one, title: d.leadButton.target.oneHint },
                ]}
              />
              {draft.contentId === null ? (
                <p className="text-xs text-(--color-fg-muted)">{d.leadButton.target.allHint} — {d.leadButton.target.appliesToAll.toLowerCase()}.</p>
              ) : reels.length === 0 ? (
                <div className="rounded-lg bg-(--color-warn-soft) p-3 text-xs leading-5 text-(--color-warn)">
                  {d.leadButton.target.noContent}{" "}
                  <Link href="/instagram" className="font-semibold underline underline-offset-2">
                    {d.leadButton.target.syncFirst}
                  </Link>
                </div>
              ) : (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {reels.map((r) => (
                    <ReelThumb key={r.id} item={r} selected={draft.contentId === r.id} onSelect={() => patch({ contentId: r.id })} />
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          {/* appearance */}
          <Card>
            <CardHeader
              icon={<IconChip color="var(--color-accent)"><MousePointerClick size={16} /></IconChip>}
              title={d.leadButton.sections.appearance}
            />
            <CardBody className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={d.leadButton.appearance.label}>
                  <Input
                    value={draft.buttonSpec.label}
                    maxLength={30}
                    placeholder={d.leadButton.appearance.labelPh}
                    onChange={(e) => patchSpec({ label: e.target.value })}
                  />
                </Field>
                <Field label={`${d.leadButton.appearance.helper} (${d.common.optional.toLowerCase()})`}>
                  <Input
                    value={draft.buttonSpec.helper}
                    maxLength={90}
                    placeholder={d.leadButton.appearance.helperPh}
                    onChange={(e) => patchSpec({ helper: e.target.value })}
                  />
                </Field>
              </div>

              <div>
                <div className="mb-1.5 text-xs font-medium text-(--color-fg-muted)">{d.leadButton.appearance.presets}</div>
                <div className="flex flex-wrap items-center gap-2">
                  {COLOR_PRESETS.map((p, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => patchSpec(p)}
                      className={cn(
                        "h-8 w-8 rounded-full border-2 transition-transform hover:scale-110",
                        draft.buttonSpec.bg === p.bg && draft.buttonSpec.fg === p.fg
                          ? "border-(--color-accent) ring-2 ring-(--color-accent-soft)"
                          : "border-(--color-border-strong)",
                      )}
                      style={{ background: p.bg }}
                      aria-label={p.bg}
                    />
                  ))}
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <ColorField label={d.leadButton.appearance.bg} value={draft.buttonSpec.bg} onChange={(v) => patchSpec({ bg: v })} />
                <ColorField label={d.leadButton.appearance.fg} value={draft.buttonSpec.fg} onChange={(v) => patchSpec({ fg: v })} />
                <ColorField
                  label={d.leadButton.appearance.border}
                  value={draft.buttonSpec.border ?? ""}
                  clearable={d.leadButton.appearance.noBorder}
                  onChange={(v) => patchSpec({ border: v || null })}
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={d.leadButton.appearance.shape}>
                  <Segmented
                    value={draft.buttonSpec.shape}
                    onChange={(v) => patchSpec({ shape: v })}
                    options={[
                      { value: "pill", label: d.leadButton.appearance.shapePill },
                      { value: "rounded", label: d.leadButton.appearance.shapeRounded },
                      { value: "square", label: d.leadButton.appearance.shapeSquare },
                    ]}
                  />
                </Field>
                <Field label={d.leadButton.appearance.size}>
                  <Segmented
                    value={draft.buttonSpec.size}
                    onChange={(v) => patchSpec({ size: v })}
                    options={[
                      { value: "sm", label: d.leadButton.appearance.sizeSm },
                      { value: "md", label: d.leadButton.appearance.sizeMd },
                      { value: "lg", label: d.leadButton.appearance.sizeLg },
                    ]}
                  />
                </Field>
                <Field label={d.leadButton.appearance.style}>
                  <Segmented
                    value={draft.buttonSpec.style}
                    onChange={(v) => patchSpec({ style: v })}
                    options={[
                      { value: "filled", label: d.leadButton.appearance.styleFilled },
                      { value: "outline", label: d.leadButton.appearance.styleOutline },
                    ]}
                  />
                </Field>
                <Field label={d.leadButton.appearance.position}>
                  <Segmented
                    value={draft.buttonSpec.position}
                    onChange={(v) => patchSpec({ position: v })}
                    options={[
                      { value: "bottom", label: d.leadButton.appearance.posBottom },
                      { value: "center", label: d.leadButton.appearance.posCenter },
                    ]}
                  />
                </Field>
              </div>
            </CardBody>
          </Card>

          {/* texts */}
          <Card>
            <CardHeader
              icon={<IconChip color="var(--color-mod-content)"><MessageCircleQuestion size={16} /></IconChip>}
              title={d.leadButton.sections.text}
            />
            <CardBody className="space-y-3">
              <Field label={d.leadButton.texts.headline} hint={d.leadButton.texts.headlineHint}>
                <Input value={draft.headline} maxLength={120} placeholder={d.leadButton.texts.headlinePh} onChange={(e) => patch({ headline: e.target.value })} />
              </Field>
              <Field label={`${d.leadButton.texts.description} (${d.common.optional.toLowerCase()})`}>
                <Input value={draft.description} maxLength={500} placeholder={d.leadButton.texts.descriptionPh} onChange={(e) => patch({ description: e.target.value })} />
              </Field>
              <Field label={d.leadButton.texts.completion}>
                <Input value={draft.completionMessage} maxLength={900} placeholder={d.leadButton.texts.completionPh} onChange={(e) => patch({ completionMessage: e.target.value })} />
              </Field>
            </CardBody>
          </Card>

          {/* questions */}
          <Card>
            <CardHeader
              icon={<IconChip color="var(--color-mod-ai)"><MessageCircleQuestion size={16} /></IconChip>}
              title={`${d.leadButton.sections.questions} · ${d.leadButton.questionsB.count(draft.questions.length)}`}
              actions={
                <Button size="sm" onClick={() => { setEditIndex(null); setEditorOpen(true); }}>
                  <Plus size={14} /> {d.leadButton.questionsB.addQuestion}
                </Button>
              }
            />
            <CardBody className="space-y-2">
              {draft.questions.length === 0 && (
                <p className="py-4 text-center text-xs text-(--color-fg-muted)">{d.leadButton.questionsB.empty}</p>
              )}
              {draft.questions.map((q, i) => (
                <div key={i} className="flex items-center gap-2.5 rounded-lg border border-(--color-border) bg-(--color-panel-2) px-3 py-2">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-(--color-accent-soft) text-[11px] font-bold text-(--color-accent)">
                    {i + 1}
                  </span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => { setEditIndex(i); setEditorOpen(true); }}
                    title={d.leadButton.questionsB.editQuestion}
                  >
                    <div className="truncate text-[13px] font-medium">{q.prompt}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-(--color-fg-faint)">
                      <Badge className="px-1 py-0">{d.leadButton.questionsB.types[q.type]}</Badge>
                      {q.required ? <span className="text-(--color-danger)">*</span> : <span>{d.common.optional}</span>}
                      {q.mapTo && <Badge tone="accent" className="px-1 py-0">{q.mapTo === "name" ? d.leadButton.questionsB.mapName : q.mapTo === "phone" ? d.leadButton.questionsB.mapPhone : d.leadButton.questionsB.mapEmail}</Badge>}
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button variant="ghost" size="icon" className="h-7 w-7" disabled={i === 0} title={d.leadButton.questionsB.moveUp}
                      onClick={() => patch({ questions: move(draft.questions, i, i - 1) })}>
                      <ChevronUp size={14} />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" disabled={i === draft.questions.length - 1} title={d.leadButton.questionsB.moveDown}
                      onClick={() => patch({ questions: move(draft.questions, i, i + 1) })}>
                      <ChevronDown size={14} />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 hover:text-(--color-danger)" title={d.common.delete}
                      onClick={() => patch({ questions: draft.questions.filter((_, j) => j !== i) })}>
                      <Trash2 size={14} />
                    </Button>
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>

          {/* delivery */}
          <Card>
            <CardHeader
              icon={<IconChip color="var(--color-mod-leads)"><Link2 size={16} /></IconChip>}
              title={d.leadButton.sections.delivery}
            />
            <CardBody className="space-y-4">
              {/* 1. link */}
              <DeliveryBlock icon={<Link2 size={15} />} color="var(--color-mod-leads)" title={d.leadButton.delivery.linkTitle} text={d.leadButton.delivery.linkText}>
                {leadButton?.landingUrl ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded-lg bg-(--color-panel-2) px-2.5 py-1.5 text-xs">{leadButton.landingUrl}</code>
                    <Button size="sm" variant="secondary" onClick={() => { void navigator.clipboard.writeText(leadButton.landingUrl!); toast.success(d.common.copied); }}>
                      <Copy size={13} /> {d.common.copy}
                    </Button>
                    <Button size="sm" variant="ghost" asChild>
                      <a href={leadButton.landingUrl} target="_blank" rel="noreferrer">
                        <ExternalLink size={13} /> {d.leadButton.delivery.openPage}
                      </a>
                    </Button>
                  </div>
                ) : (
                  <p className="text-xs italic text-(--color-fg-faint)">{d.leadButton.delivery.saveFirst}</p>
                )}
              </DeliveryBlock>

              {/* 2. keyword */}
              <DeliveryBlock icon={<KeyRound size={15} />} color="var(--color-mod-ai)" title={d.leadButton.delivery.keywordTitle} text={d.leadButton.delivery.keywordText}>
                <div className="flex flex-wrap items-center gap-1.5">
                  {draft.triggerKeywords.map((k) => (
                    <span key={k} className="inline-flex items-center gap-1 rounded-full bg-(--color-accent-soft) px-2.5 py-1 text-xs font-semibold text-(--color-accent)">
                      {k.toUpperCase()}
                      <button type="button" onClick={() => patch({ triggerKeywords: draft.triggerKeywords.filter((x) => x !== k) })} aria-label={d.common.delete}>
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                  <div className="flex items-center gap-1.5">
                    <Input
                      className="h-8 w-32 text-xs"
                      value={keywordInput}
                      placeholder={d.leadButton.delivery.keywordPh}
                      maxLength={60}
                      onChange={(e) => setKeywordInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addKeyword();
                        }
                      }}
                    />
                    <Button size="sm" variant="secondary" onClick={addKeyword}>
                      <Plus size={13} /> {d.leadButton.delivery.addKeyword}
                    </Button>
                  </div>
                </div>
              </DeliveryBlock>

              {/* 3. paid ad */}
              <DeliveryBlock icon={<Megaphone size={15} />} color="var(--color-mod-ads)" title={d.leadButton.delivery.adTitle} text={d.leadButton.delivery.adText}>
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={d.leadButton.delivery.adCta} className="w-48">
                    <Select value={draft.ctaType ?? "SIGN_UP"} onChange={(e) => patch({ ctaType: e.target.value })}>
                      {nativeCtaTypes.map((c) => (
                        <option key={c.value} value={c.value}>{c.label}</option>
                      ))}
                    </Select>
                  </Field>
                  {adsReady ? (
                    <Button asChild variant="secondary" disabled={!leadButton?.landingUrl}>
                      <Link
                        href={`/campaigns?new=1&contentId=${draft.contentId ?? ""}&cta=${draft.ctaType ?? "SIGN_UP"}&url=${encodeURIComponent(leadButton?.landingUrl ?? "")}`}
                      >
                        <Megaphone size={14} /> {d.leadButton.delivery.adCreate}
                      </Link>
                    </Button>
                  ) : (
                    <p className="text-xs text-(--color-warn)">
                      {d.leadButton.delivery.adNeedsFacebook}{" "}
                      <Link href="/instagram" className="font-semibold underline underline-offset-2">{d.nav.instagram} →</Link>
                    </p>
                  )}
                </div>
                <p className="mt-2 text-[11px] text-(--color-fg-faint)">{d.leadButton.delivery.adNote}</p>
              </DeliveryBlock>
            </CardBody>
          </Card>

          <div className="flex justify-end pb-6">
            <Button size="lg" onClick={save} disabled={saving || !dirty}>
              {saving ? d.common.saving : d.leadButton.saveButton}
            </Button>
          </div>
        </div>
      </div>

      <QuestionEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        initial={editIndex !== null ? draft.questions[editIndex]! : null}
        onSave={(q) => {
          if (editIndex === null) patch({ questions: [...draft.questions, q] });
          else patch({ questions: draft.questions.map((old, i) => (i === editIndex ? q : old)) });
        }}
      />
    </>
  );

  function addKeyword() {
    const k = keywordInput.trim().toLowerCase();
    if (!k || !draft) return;
    if (!draft.triggerKeywords.includes(k)) patch({ triggerKeywords: [...draft.triggerKeywords, k] });
    setKeywordInput("");
  }
}

/* ---------- small pieces ---------- */

function HowStep({ icon, color, n, text }: { icon: React.ReactNode; color: string; n: number; text: string }) {
  return (
    <div className="flex min-w-0 flex-1 basis-40 items-center gap-2.5">
      <IconChip color={color} size={34}>{icon}</IconChip>
      <div className="min-w-0">
        <div className="text-[10px] font-bold uppercase tracking-wide text-(--color-fg-faint)">{n}</div>
        <div className="truncate text-xs font-medium">{text}</div>
      </div>
    </div>
  );
}

function ReelThumb({ item, selected, onSelect }: { item: ContentItemLite; selected: boolean; onSelect: () => void }) {
  const [ok, setOk] = React.useState(true);
  const src = item.thumbnailUrl ?? item.mediaUrl;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative aspect-[9/16] w-20 shrink-0 overflow-hidden rounded-lg border-2 transition-all",
        selected ? "border-(--color-accent) ring-2 ring-(--color-accent-soft)" : "border-transparent opacity-80 hover:opacity-100",
      )}
      title={item.caption ?? ""}
    >
      {src && ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" className="h-full w-full object-cover" onError={() => setOk(false)} />
      ) : (
        <span className="grid h-full w-full place-items-center bg-gradient-to-br from-fuchsia-500 to-indigo-600 text-white">
          <Film size={18} />
        </span>
      )}
      {selected && <span className="absolute inset-x-0 bottom-0 bg-(--color-accent) py-0.5 text-center text-[9px] font-bold text-white">✓</span>}
    </button>
  );
}

function ColorField({ label, value, onChange, clearable }: { label: string; value: string; onChange: (v: string) => void; clearable?: string }) {
  const valid = /^#[0-9a-fA-F]{6}$/.test(value);
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-(--color-fg-muted)">{label}</div>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          className="h-9 w-10 shrink-0"
          value={valid ? value : "#888888"}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
        />
        <Input className="h-9 font-mono text-xs" value={value} placeholder={clearable ?? "#000000"} maxLength={7}
          onChange={(e) => onChange(e.target.value)} />
        {clearable !== undefined && value && (
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" title={clearable} onClick={() => onChange("")}>
            <X size={13} />
          </Button>
        )}
      </div>
    </div>
  );
}

function DeliveryBlock({ icon, color, title, text, children }: { icon: React.ReactNode; color: string; title: string; text: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-(--color-border) p-3.5">
      <div className="mb-1 flex items-center gap-2">
        <IconChip color={color} size={26}>{icon}</IconChip>
        <span className="text-[13px] font-semibold">{title}</span>
      </div>
      <p className="mb-2.5 text-xs leading-5 text-(--color-fg-muted)">{text}</p>
      {children}
    </div>
  );
}

function move<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}
