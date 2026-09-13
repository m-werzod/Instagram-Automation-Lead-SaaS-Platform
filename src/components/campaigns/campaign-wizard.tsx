"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, ExternalLink, Film, Info, MapPin, Search, Sparkles, Users, X } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Segmented, Select, Textarea } from "@/components/ui/input";
import { cn, centsToMoney } from "@/lib/utils";
import { AdPhonePreview } from "./ad-preview";
import { AdBillingInline, type AdBillingStatus } from "./ad-billing-status";
import { computeCampaignQuote, type Pricing } from "@/lib/billing/pricing";

/**
 * Target wizard: content → goal → audience → budget & dates → button → review.
 * Everything typed here becomes a LOCAL draft; money only moves after the
 * separate "create in Meta (paused)" and typed-confirmation "start" steps.
 * The only audience number shown is Meta's own reach estimate.
 */

export interface WizardOptions {
  objectives: Array<{ value: string; label: string; needsPage: boolean }>;
  ctaTypes: Array<{ value: string; label: string }>;
  instagramPositions: readonly string[];
}

export interface ContentOption {
  id: string;
  caption: string | null;
  thumbnailUrl: string | null;
  mediaUrl: string | null;
  mediaProductType: string | null;
}

/** The account's Lead Button (ONE per account — see /api/lead-button), as this wizard needs it. */
interface LinkedLeadButton {
  id: string;
  landingUrl: string | null;
  contentId: string | null;
  ctaType: string | null;
}

interface City {
  key: string;
  name: string;
  radius: number;
  distanceUnit: "kilometer" | "mile";
}
interface Interest {
  id: string;
  name: string;
}

export interface WizardDraft {
  id?: string;
  name: string;
  objective: string;
  contentId: string | null;
  /** The Lead Button (CtaConfig) this ad uses, if the admin picked the account's existing one. */
  ctaConfigId: string | null;
  adText: string;
  countries: string[];
  cities: City[];
  ageMin: number;
  ageMax: number;
  gender: "all" | "men" | "women";
  interests: Interest[];
  positions: string[];
  budgetKind: "daily" | "lifetime";
  amount: string; // major units
  currency: string;
  startLocal: string;
  endLocal: string;
  ctaType: string;
  destinationUrl: string;
  metaFormId: string;
}

export interface WizardInitial {
  id: string;
  name: string;
  objective: string;
  contentId: string | null;
  ctaConfigId: string | null;
  dailyBudgetCents: number | null;
  lifetimeBudgetCents: number | null;
  currency: string;
  startTime: string | null;
  endTime: string | null;
  targeting: {
    countries?: string[];
    cities?: Array<{ key: string; name?: string; radius?: number; distanceUnit?: "kilometer" | "mile" }>;
    ageMin?: number;
    ageMax?: number;
    genders?: number[];
    interests?: Array<{ id: string; name?: string }>;
    instagramPositions?: string[];
  } | null;
  ctaType: string | null;
  destinationUrl: string | null;
  metaFormId: string | null;
  creativeSpec: { message?: string } | null;
}

type Estimate = { available: true; usersLowerBound: number; usersUpperBound: number } | { available: false; reason: string };

const STEPS = ["content", "objective", "audience", "budget", "button", "review"] as const;
type Step = (typeof STEPS)[number];

function toLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function emptyDraft(currency: string, prefill?: { contentId?: string; ctaType?: string | null; destinationUrl?: string }): WizardDraft {
  return {
    name: "",
    objective: "OUTCOME_TRAFFIC",
    contentId: prefill?.contentId || null,
    ctaConfigId: null,
    adText: "",
    countries: ["UZ"],
    cities: [],
    ageMin: 18,
    ageMax: 45,
    gender: "all",
    interests: [],
    positions: ["stream", "reels"],
    budgetKind: "daily",
    amount: "5",
    currency,
    startLocal: "",
    endLocal: "",
    ctaType: prefill?.ctaType ?? "SIGN_UP",
    destinationUrl: prefill?.destinationUrl ?? "",
    metaFormId: "",
  };
}

function fromInitial(c: WizardInitial): WizardDraft {
  const t = c.targeting ?? {};
  const cents = c.lifetimeBudgetCents ?? c.dailyBudgetCents ?? 500;
  return {
    id: c.id,
    name: c.name,
    objective: c.objective,
    contentId: c.contentId,
    ctaConfigId: c.ctaConfigId,
    adText: c.creativeSpec?.message ?? "",
    countries: t.countries ?? [],
    cities: (t.cities ?? []).map((x) => ({ key: x.key, name: x.name ?? x.key, radius: x.radius ?? 25, distanceUnit: x.distanceUnit ?? "kilometer" })),
    ageMin: t.ageMin ?? 18,
    ageMax: t.ageMax ?? 65,
    gender: t.genders?.length === 1 ? (t.genders[0] === 1 ? "men" : "women") : "all",
    interests: (t.interests ?? []).map((i) => ({ id: i.id, name: i.name ?? i.id })),
    positions: t.instagramPositions ?? ["stream", "reels"],
    budgetKind: c.lifetimeBudgetCents ? "lifetime" : "daily",
    amount: String(cents / 100),
    currency: c.currency,
    startLocal: toLocal(c.startTime),
    endLocal: toLocal(c.endTime),
    ctaType: c.ctaType ?? "SIGN_UP",
    destinationUrl: c.destinationUrl ?? "",
    metaFormId: c.metaFormId ?? "",
  };
}

function toPayload(dr: WizardDraft) {
  const cents = Math.round(Number(dr.amount) * 100);
  return {
    name: dr.name.trim(),
    objective: dr.objective,
    dailyBudgetCents: dr.budgetKind === "daily" ? cents : null,
    lifetimeBudgetCents: dr.budgetKind === "lifetime" ? cents : null,
    currency: dr.currency,
    startTime: dr.startLocal ? new Date(dr.startLocal).toISOString() : null,
    endTime: dr.endLocal ? new Date(dr.endLocal).toISOString() : null,
    targeting: {
      countries: dr.countries,
      cities: dr.cities.map((c) => ({ key: c.key, name: c.name, radius: c.radius, distanceUnit: c.distanceUnit })),
      ageMin: dr.ageMin,
      ageMax: dr.ageMax,
      genders: dr.gender === "men" ? [1] : dr.gender === "women" ? [2] : [],
      interests: dr.interests,
      instagramPositions: dr.positions,
    },
    ctaType: dr.objective === "OUTCOME_AWARENESS" && !dr.destinationUrl ? null : dr.ctaType,
    destinationType: dr.objective === "OUTCOME_TRAFFIC" ? "WEBSITE" : dr.objective === "OUTCOME_ENGAGEMENT" ? "INSTAGRAM_DIRECT" : dr.objective === "OUTCOME_LEADS" ? "LEAD_FORM" : null,
    destinationUrl: dr.destinationUrl.trim() || null,
    contentId: dr.contentId,
    ctaConfigId: dr.ctaConfigId,
    metaFormId: dr.metaFormId.trim() || null,
    creativeSpec: dr.contentId ? null : { message: dr.adText.trim() || dr.name.trim() },
  };
}

export function CampaignWizard({
  open,
  onOpenChange,
  accountId,
  username,
  adsReady,
  hasPage,
  currency,
  options,
  contentOptions,
  prefill,
  initial,
  billingStatus,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
  username: string;
  adsReady: boolean;
  hasPage: boolean;
  currency: string;
  options: WizardOptions;
  contentOptions: ContentOption[];
  prefill?: { contentId?: string; ctaType?: string | null; destinationUrl?: string } | null;
  initial?: WizardInitial | null;
  billingStatus?: AdBillingStatus | null;
  onSaved: () => Promise<void>;
}) {
  const { d } = useI18n();
  const t = d.campaigns.wizard;
  const [step, setStep] = React.useState<Step>("content");
  const [draft, setDraft] = React.useState<WizardDraft>(() => (initial ? fromInitial(initial) : emptyDraft(currency, prefill ?? undefined)));
  const [busy, setBusy] = React.useState(false);
  const [estimate, setEstimate] = React.useState<Estimate | null>(null);
  const [estimating, setEstimating] = React.useState(false);
  const [pricing, setPricing] = React.useState<Pricing | null>(null);
  const [leadButton, setLeadButton] = React.useState<LinkedLeadButton | null>(null);

  React.useEffect(() => {
    if (!open) return;
    api<{ pricing: Pricing }>("/api/billing/pricing", { silent: true })
      .then((res) => setPricing(res.pricing))
      .catch(() => setPricing(null));
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    api<{ leadButton: LinkedLeadButton | null }>(`/api/lead-button?accountId=${accountId}`, { silent: true })
      .then((res) => setLeadButton(res.leadButton))
      .catch(() => setLeadButton(null));
  }, [open, accountId]);

  React.useEffect(() => {
    if (!open) return;
    setStep("content");
    setDraft(initial ? fromInitial(initial) : emptyDraft(currency, prefill ?? undefined));
    setEstimate(null);
  }, [open, initial, currency, prefill]);

  const patch = (p: Partial<WizardDraft>) => {
    setDraft((prev) => ({ ...prev, ...p }));
    if ("countries" in p || "cities" in p || "ageMin" in p || "ageMax" in p || "gender" in p || "interests" in p || "positions" in p) setEstimate(null);
  };

  const selectedContent = draft.contentId ? contentOptions.find((c) => c.id === draft.contentId) ?? null : null;
  // The Lead Button is a singleton per account — "does this reel have one" is
  // really "is the account's one Lead Button pointed at this reel, or at none in particular".
  const matchingLeadButton =
    leadButton?.landingUrl && (leadButton.contentId === draft.contentId || leadButton.contentId === null) ? leadButton : null;
  const objective = options.objectives.find((o) => o.value === draft.objective);
  const ctaLabel =
    draft.objective === "OUTCOME_AWARENESS" && !draft.destinationUrl ? null : options.ctaTypes.find((c) => c.value === draft.ctaType)?.label ?? draft.ctaType;
  const stepIndex = STEPS.indexOf(step);

  function stepProblem(s: Step): string | null {
    switch (s) {
      case "content":
        if (!draft.contentId && !draft.adText.trim()) return t.problems.content;
        return null;
      case "objective":
        if (objective?.needsPage && !hasPage) return t.needsPage;
        return null;
      case "audience":
        if (draft.countries.length === 0 && draft.cities.length === 0) return t.problems.location;
        if (draft.ageMin > draft.ageMax) return t.problems.age;
        return null;
      case "budget": {
        const n = Number(draft.amount);
        if (!Number.isFinite(n) || n < 1) return t.problems.amount;
        if (draft.budgetKind === "lifetime" && !draft.endLocal) return t.endRequired;
        if (draft.startLocal && draft.endLocal && new Date(draft.endLocal) <= new Date(draft.startLocal)) return t.problems.dates;
        return null;
      }
      case "button":
        if (draft.objective === "OUTCOME_TRAFFIC" && !/^https?:\/\//.test(draft.destinationUrl)) return t.problems.url;
        if (draft.objective === "OUTCOME_LEADS" && !draft.metaFormId.trim()) return t.problems.form;
        if (!draft.name.trim()) return t.problems.name;
        return null;
      default:
        return null;
    }
  }
  const problem = stepProblem(step);

  async function getEstimate() {
    setEstimating(true);
    try {
      const res = await api<{ estimate: Estimate }>("/api/campaigns/estimate", {
        method: "POST",
        json: { accountId, targeting: toPayload(draft).targeting, campaignId: draft.id },
      });
      setEstimate(res.estimate);
    } catch {
      /* toast from api() */
    } finally {
      setEstimating(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      const payload = toPayload(draft);
      if (draft.id) await api(`/api/campaigns/${draft.id}`, { method: "PATCH", json: payload });
      else await api("/api/campaigns", { method: "POST", json: { accountId, ...payload } });
      toast.success(t.created);
      onOpenChange(false);
      await onSaved();
    } catch {
      /* toast from api() */
    } finally {
      setBusy(false);
    }
  }

  const amountCents = Math.round(Number(draft.amount) * 100);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide title={draft.id ? `${t.edit}: ${draft.name}` : d.campaigns.create} description={d.campaigns.subtitle} className="max-w-5xl">
        {/* step rail */}
        <ol className="mb-4 flex flex-wrap gap-1 text-[11px]">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => i <= stepIndex && setStep(s)}
                className={cn(
                  "rounded-md px-2 py-1 font-medium",
                  s === step ? "bg-(--color-accent) text-white" : i < stepIndex ? "bg-(--color-ok-soft) text-(--color-ok)" : "bg-(--color-panel-2) text-(--color-fg-faint)",
                )}
              >
                {i < stepIndex ? <Check size={10} className="mr-1 inline" /> : `${i + 1}. `}
                {t.steps[s]}
              </button>
              {i < STEPS.length - 1 && <ChevronRight size={12} className="text-(--color-fg-faint)" />}
            </li>
          ))}
        </ol>

        <div className="grid gap-5 md:grid-cols-[280px_1fr]">
          <AdPhonePreview
            thumb={selectedContent?.thumbnailUrl ?? selectedContent?.mediaUrl ?? null}
            caption={selectedContent?.caption ?? draft.adText}
            username={username}
            ctaLabel={ctaLabel}
            placement={draft.positions.includes("reels") && (selectedContent?.mediaProductType === "REELS" || !draft.positions.includes("stream")) ? "reels" : "feed"}
            destinationHint={
              draft.objective === "OUTCOME_ENGAGEMENT"
                ? t.directHint
                : draft.objective === "OUTCOME_LEADS"
                  ? t.objectiveHelp.OUTCOME_LEADS
                  : draft.destinationUrl
                    ? `→ ${draft.destinationUrl}`
                    : undefined
            }
          />

          <div className="min-w-0 space-y-4">
            {step === "content" && (
              <>
                <Field label={t.pickContent}>
                  <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4">
                    <button
                      type="button"
                      onClick={() => patch({ contentId: null })}
                      className={cn(
                        "flex aspect-[4/5] flex-col items-center justify-center gap-1 rounded-lg border p-2 text-center text-[11px] leading-4",
                        !draft.contentId ? "border-(--color-accent) bg-(--color-accent-soft)" : "border-(--color-border)",
                      )}
                    >
                      <Sparkles size={16} /> {t.noContent}
                    </button>
                    {contentOptions.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => patch({ contentId: c.id })}
                        className={cn(
                          "relative aspect-[4/5] overflow-hidden rounded-lg border",
                          draft.contentId === c.id ? "border-(--color-accent) ring-2 ring-(--color-accent)" : "border-(--color-border)",
                        )}
                        title={c.caption ?? ""}
                      >
                        {c.thumbnailUrl || c.mediaUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={c.thumbnailUrl ?? c.mediaUrl ?? ""} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="grid h-full w-full place-items-center bg-gradient-to-br from-fuchsia-500 to-indigo-600 text-white">
                            <Film size={18} />
                          </span>
                        )}
                        {c.mediaProductType === "REELS" && <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] text-white">Reel</span>}
                      </button>
                    ))}
                  </div>
                </Field>
                {!draft.contentId && (
                  <Field label={t.adText}>
                    <Textarea rows={3} maxLength={2000} value={draft.adText} onChange={(e) => patch({ adText: e.target.value })} />
                  </Field>
                )}
              </>
            )}

            {step === "objective" && (
              <div className="grid gap-2 sm:grid-cols-2">
                {options.objectives.map((o) => {
                  const blocked = o.needsPage && !hasPage;
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => patch({ objective: o.value, ctaType: o.value === "OUTCOME_ENGAGEMENT" ? "MESSAGE_PAGE" : draft.ctaType === "MESSAGE_PAGE" ? "SIGN_UP" : draft.ctaType })}
                      className={cn(
                        "rounded-xl border p-3 text-left",
                        draft.objective === o.value ? "border-(--color-accent) bg-(--color-accent-soft)" : "border-(--color-border)",
                        blocked && "opacity-70",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 text-sm font-semibold">
                        {(d.campaigns.objectives as Record<string, string>)[o.value] ?? o.label}
                        {blocked && <Badge tone="warn">{t.needsPageShort}</Badge>}
                      </div>
                      <p className="mt-1 text-[11px] leading-4 text-(--color-fg-muted)">{(t.objectiveHelp as Record<string, string>)[o.value]}</p>
                    </button>
                  );
                })}
              </div>
            )}

            {step === "audience" && (
              <AudienceStep draft={draft} patch={patch} accountId={accountId} adsReady={adsReady} positions={options.instagramPositions} />
            )}

            {step === "budget" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t.budgetKind} className="sm:col-span-2">
                  <Segmented
                    value={draft.budgetKind}
                    onChange={(v) => patch({ budgetKind: v })}
                    options={[
                      { value: "daily", label: t.daily },
                      { value: "lifetime", label: t.lifetime },
                    ]}
                  />
                </Field>
                <Field label={`${t.amount} (${draft.currency})`} hint={Number.isFinite(amountCents) && amountCents > 0 ? centsToMoney(amountCents, draft.currency) + (draft.budgetKind === "daily" ? d.campaigns.perDayShort : "") : undefined}>
                  <Input type="number" min="1" step="0.5" value={draft.amount} onChange={(e) => patch({ amount: e.target.value })} />
                </Field>
                <Field label={t.currency} hint={t.currencyHint}>
                  <Input value={draft.currency} maxLength={3} onChange={(e) => patch({ currency: e.target.value.toUpperCase() })} />
                </Field>
                <Field label={t.start}>
                  <Input type="datetime-local" value={draft.startLocal} onChange={(e) => patch({ startLocal: e.target.value })} />
                </Field>
                <Field label={t.end} hint={draft.budgetKind === "lifetime" ? t.endRequired : undefined}>
                  <Input type="datetime-local" value={draft.endLocal} onChange={(e) => patch({ endLocal: e.target.value })} />
                </Field>
              </div>
            )}

            {step === "button" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={d.campaigns.fields.name} className="sm:col-span-2">
                  <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} maxLength={150} placeholder={t.namePh} />
                </Field>

                {(draft.objective === "OUTCOME_TRAFFIC" || draft.objective === "OUTCOME_AWARENESS") && (
                  <div className="sm:col-span-2">
                    {matchingLeadButton ? (
                      <Segmented
                        value={draft.ctaConfigId ? "existing" : "custom"}
                        onChange={(v) =>
                          patch(
                            v === "existing"
                              ? { ctaConfigId: matchingLeadButton.id, ctaType: matchingLeadButton.ctaType ?? draft.ctaType, destinationUrl: matchingLeadButton.landingUrl ?? draft.destinationUrl }
                              : { ctaConfigId: null },
                          )
                        }
                        options={[
                          { value: "existing", label: t.useLeadButton },
                          { value: "custom", label: t.customButton },
                        ]}
                      />
                    ) : (
                      <a
                        href={`/lead-button${draft.contentId ? `?contentId=${draft.contentId}` : ""}`}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-(--color-accent) underline underline-offset-2"
                      >
                        <ExternalLink size={13} /> {t.setUpLeadButton}
                      </a>
                    )}
                  </div>
                )}
                {draft.objective !== "OUTCOME_ENGAGEMENT" && (
                  <Field label={t.ctaType} hint={draft.ctaConfigId ? t.fromLeadButton : t.ctaFixedLook}>
                    <Select value={draft.ctaType} disabled={Boolean(draft.ctaConfigId)} onChange={(e) => patch({ ctaType: e.target.value })}>
                      {options.ctaTypes.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                {(draft.objective === "OUTCOME_TRAFFIC" || draft.objective === "OUTCOME_AWARENESS") && (
                  <Field label={t.destination} hint={draft.ctaConfigId ? t.fromLeadButton : draft.objective === "OUTCOME_AWARENESS" ? t.destinationOptional : undefined}>
                    <Input
                      value={draft.destinationUrl}
                      disabled={Boolean(draft.ctaConfigId)}
                      onChange={(e) => patch({ destinationUrl: e.target.value })}
                      placeholder={t.destinationPh}
                    />
                  </Field>
                )}
                {draft.objective === "OUTCOME_ENGAGEMENT" && (
                  <p className="flex items-start gap-2 rounded-lg bg-(--color-panel-2) p-3 text-xs leading-5 text-(--color-fg-muted) sm:col-span-2">
                    <Info size={14} className="mt-0.5 shrink-0" /> {t.directHint}
                  </p>
                )}
                {draft.objective === "OUTCOME_LEADS" && (
                  <Field label={t.instantForm} hint={t.instantFormHint} className="sm:col-span-2">
                    <div className="flex gap-2">
                      <Input value={draft.metaFormId} onChange={(e) => patch({ metaFormId: e.target.value })} placeholder="1234567890" />
                      <Button asChild type="button" variant="secondary">
                        <a href="https://business.facebook.com/latest/instant_forms" target="_blank" rel="noreferrer">
                          <ExternalLink size={13} /> {t.openAdsManager}
                        </a>
                      </Button>
                    </div>
                  </Field>
                )}
              </div>
            )}

            {step === "review" && (
              <ReviewStep
                draft={draft}
                objectiveLabel={(d.campaigns.objectives as Record<string, string>)[draft.objective] ?? draft.objective}
                ctaLabel={ctaLabel}
                selectedContent={selectedContent}
                estimate={estimate}
                estimating={estimating}
                adsReady={adsReady}
                onEstimate={getEstimate}
                pricing={pricing}
                billingStatus={billingStatus ?? null}
              />
            )}

            {problem && (
              <p className="flex items-start gap-2 rounded-lg bg-(--color-warn-soft) px-3 py-2 text-xs leading-5 text-(--color-warn)">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {problem}
              </p>
            )}

            <div className="flex items-center justify-between gap-2 border-t border-(--color-border) pt-3">
              <Button type="button" variant="ghost" disabled={stepIndex === 0} onClick={() => setStep(STEPS[stepIndex - 1]!)}>
                <ChevronLeft size={14} /> {t.back}
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                  {d.common.cancel}
                </Button>
                {step !== "review" ? (
                  <Button type="button" disabled={Boolean(problem)} onClick={() => setStep(STEPS[stepIndex + 1]!)}>
                    {t.next} <ChevronRight size={14} />
                  </Button>
                ) : (
                  <Button type="button" disabled={busy || STEPS.some((s) => stepProblem(s))} onClick={() => void save()}>
                    {busy ? t.saving : t.saveDraft}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- audience ---------- */

function AudienceStep({
  draft,
  patch,
  accountId,
  adsReady,
  positions,
}: {
  draft: WizardDraft;
  patch: (p: Partial<WizardDraft>) => void;
  accountId: string;
  adsReady: boolean;
  positions: readonly string[];
}) {
  const { d } = useI18n();
  const t = d.campaigns.wizard;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={t.countries} className="sm:col-span-2">
        <Input
          value={draft.countries.join(", ")}
          onChange={(e) =>
            patch({
              countries: e.target.value
                .split(",")
                .map((c) => c.trim().toUpperCase())
                .filter((c) => c.length === 2),
            })
          }
          placeholder="UZ, KZ"
        />
      </Field>

      <Field label={t.cities} className="sm:col-span-2" hint={adsReady ? undefined : t.searchNeedsAds}>
        <SearchPicker
          type="city"
          accountId={accountId}
          country={draft.countries[0]}
          disabled={!adsReady}
          placeholder={t.citySearchPh}
          onPick={(r) => {
            if (!draft.cities.some((c) => c.key === r.key)) patch({ cities: [...draft.cities, { key: r.key, name: r.label, radius: 25, distanceUnit: "kilometer" }] });
          }}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {draft.cities.map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1 rounded-md bg-(--color-panel-2) px-2 py-1 text-[11px]">
              <MapPin size={11} /> {c.name}
              <input
                type="number"
                min={17}
                max={80}
                value={c.radius}
                onChange={(e) => patch({ cities: draft.cities.map((x) => (x.key === c.key ? { ...x, radius: Number(e.target.value) || 25 } : x)) })}
                className="w-12 rounded border border-(--color-border) bg-(--color-panel) px-1 text-[11px]"
                aria-label={t.radius}
              />
              km
              <button type="button" onClick={() => patch({ cities: draft.cities.filter((x) => x.key !== c.key) })} aria-label={d.common.delete}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      </Field>

      <Field label={d.campaigns.fields.age}>
        <div className="flex items-center gap-2">
          <Input type="number" min={18} max={65} value={draft.ageMin} onChange={(e) => patch({ ageMin: Number(e.target.value) || 18 })} aria-label="min age" />
          <span className="text-xs text-(--color-fg-faint)">–</span>
          <Input type="number" min={18} max={65} value={draft.ageMax} onChange={(e) => patch({ ageMax: Number(e.target.value) || 65 })} aria-label="max age" />
        </div>
      </Field>
      <Field label={t.gender}>
        <Segmented
          value={draft.gender}
          onChange={(v) => patch({ gender: v })}
          options={[
            { value: "all", label: t.genders.all },
            { value: "men", label: t.genders.men },
            { value: "women", label: t.genders.women },
          ]}
        />
      </Field>

      <Field label={t.interests} className="sm:col-span-2" hint={adsReady ? t.interestsHint : t.searchNeedsAds}>
        <SearchPicker
          type="interest"
          accountId={accountId}
          disabled={!adsReady}
          placeholder={t.interestSearchPh}
          onPick={(r) => {
            if (!draft.interests.some((i) => i.id === r.key)) patch({ interests: [...draft.interests, { id: r.key, name: r.label }] });
          }}
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {draft.interests.map((i) => (
            <span key={i.id} className="inline-flex items-center gap-1 rounded-md bg-(--color-accent-soft) px-2 py-1 text-[11px] text-(--color-accent)">
              <Users size={11} /> {i.name}
              <button type="button" onClick={() => patch({ interests: draft.interests.filter((x) => x.id !== i.id) })} aria-label={d.common.delete}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      </Field>

      <Field label={t.placements} className="sm:col-span-2">
        <div className="flex flex-wrap gap-1.5">
          {positions.map((p) => {
            const on = draft.positions.includes(p);
            return (
              <button
                key={p}
                type="button"
                onClick={() => {
                  const next = on ? draft.positions.filter((x) => x !== p) : [...draft.positions, p];
                  if (next.length > 0) patch({ positions: next });
                }}
                className={cn(
                  "rounded-md border px-2.5 py-1 text-xs font-medium",
                  on ? "border-(--color-accent) bg-(--color-accent-soft) text-(--color-accent)" : "border-(--color-border) text-(--color-fg-muted)",
                )}
              >
                {(t.placementNames as Record<string, string>)[p] ?? p}
              </button>
            );
          })}
        </div>
      </Field>
    </div>
  );
}

function SearchPicker({
  type,
  accountId,
  country,
  disabled,
  placeholder,
  onPick,
}: {
  type: "city" | "interest";
  accountId: string;
  country?: string;
  disabled?: boolean;
  placeholder: string;
  onPick: (r: { key: string; label: string }) => void;
}) {
  const [q, setQ] = React.useState("");
  const [results, setResults] = React.useState<Array<{ key: string; label: string; detail: string }>>([]);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    if (disabled || q.trim().length < 2) {
      setResults([]);
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams({ accountId, type, q: q.trim() });
        if (country && type === "city") params.set("country", country);
        const res = await api<{ results: Array<Record<string, unknown>> }>(`/api/campaigns/search?${params}`, { silent: true });
        setResults(
          res.results.map((r) =>
            type === "city"
              ? { key: String(r.key), label: String(r.name), detail: [r.region, r.countryName ?? r.countryCode].filter(Boolean).join(", ") }
              : {
                  key: String(r.id),
                  label: String(r.name),
                  detail:
                    typeof r.audienceLower === "number" && typeof r.audienceUpper === "number"
                      ? `${(r.audienceLower as number).toLocaleString()} – ${(r.audienceUpper as number).toLocaleString()}`
                      : Array.isArray(r.path)
                        ? (r.path as string[]).join(" › ")
                        : "",
                },
          ),
        );
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [q, type, accountId, country, disabled]);

  return (
    <div className="relative">
      <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-(--color-fg-faint)" />
      <Input className="pl-8" value={q} disabled={disabled} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} />
      {(results.length > 0 || loading) && (
        <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-(--color-border) bg-(--color-panel) shadow-lg">
          {loading && <li className="px-3 py-2 text-xs text-(--color-fg-faint)">…</li>}
          {results.map((r) => (
            <li key={r.key}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-(--color-panel-2)"
                onClick={() => {
                  onPick(r);
                  setQ("");
                  setResults([]);
                }}
              >
                <span className="font-medium">{r.label}</span>
                <span className="truncate text-(--color-fg-faint)">{r.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- review ---------- */

function ReviewStep({
  draft,
  objectiveLabel,
  ctaLabel,
  selectedContent,
  estimate,
  estimating,
  adsReady,
  onEstimate,
  pricing,
  billingStatus,
}: {
  draft: WizardDraft;
  objectiveLabel: string;
  ctaLabel: string | null;
  selectedContent: ContentOption | null;
  estimate: Estimate | null;
  estimating: boolean;
  adsReady: boolean;
  onEstimate: () => void;
  pricing: Pricing | null;
  billingStatus: AdBillingStatus | null;
}) {
  const { d } = useI18n();
  const t = d.campaigns.wizard;
  const cents = Math.round(Number(draft.amount) * 100);
  const quote = pricing
    ? computeCampaignQuote({ dailyBudgetCents: draft.budgetKind === "daily" ? cents : null, lifetimeBudgetCents: draft.budgetKind === "lifetime" ? cents : null }, pricing)
    : null;
  const rows: Array<[string, string]> = [
    [d.campaigns.fields.name, draft.name],
    [d.campaigns.objective, objectiveLabel],
    [d.campaigns.fields.content, selectedContent ? (selectedContent.caption ?? selectedContent.id).slice(0, 60) : t.noContent],
    [t.countries, draft.countries.join(", ") || "—"],
    [t.cities, draft.cities.map((c) => `${c.name} (${c.radius} km)`).join(", ") || "—"],
    [d.campaigns.fields.age, `${draft.ageMin}–${draft.ageMax}`],
    [t.gender, t.genders[draft.gender]],
    [t.interests, draft.interests.map((i) => i.name).join(", ") || "—"],
    [t.placements, draft.positions.map((p) => (t.placementNames as Record<string, string>)[p] ?? p).join(", ")],
    [d.campaigns.budget, `${centsToMoney(cents, draft.currency)}${draft.budgetKind === "daily" ? d.campaigns.perDayShort : ` (${t.lifetime})`}`],
    [t.start, draft.startLocal ? new Date(draft.startLocal).toLocaleString() : t.asap],
    [t.end, draft.endLocal ? new Date(draft.endLocal).toLocaleString() : t.untilStopped],
    [t.ctaType, ctaLabel ?? "—"],
    [t.destination, draft.objective === "OUTCOME_ENGAGEMENT" ? "Instagram Direct" : draft.objective === "OUTCOME_LEADS" ? `Instant Form ${draft.metaFormId}` : draft.destinationUrl || "—"],
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-(--color-border)">
        <div className="border-b border-(--color-border) px-3 py-2 text-xs font-semibold">{t.summary}</div>
        <dl className="grid gap-x-4 gap-y-1 px-3 py-2 text-xs sm:grid-cols-2">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="shrink-0 text-(--color-fg-muted)">{k}:</dt>
              <dd className="min-w-0 break-words font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* Meta's estimate — the only audience number, clearly labelled */}
      <div className="rounded-xl border border-(--color-border) p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold">{t.estimateTitle}</span>
          <Button type="button" size="sm" variant="secondary" disabled={estimating || !adsReady} onClick={onEstimate} title={adsReady ? undefined : t.searchNeedsAds}>
            {estimating ? t.estimating : t.getEstimate}
          </Button>
        </div>
        <div className="mt-2 text-sm">
          {estimate === null ? (
            <span className="text-xs text-(--color-fg-faint)">{adsReady ? t.estimateIdle : t.searchNeedsAds}</span>
          ) : estimate.available ? (
            <>
              <div className="text-lg font-bold tabular-nums">{t.estimateRange(estimate.usersLowerBound.toLocaleString(), estimate.usersUpperBound.toLocaleString())}</div>
              <div className="text-[11px] text-(--color-fg-faint)">{t.estimateNote}</div>
            </>
          ) : (
            <div className="text-xs text-(--color-warn)">{estimate.reason}</div>
          )}
        </div>
        <p className="mt-2 text-[11px] leading-4 text-(--color-fg-faint)">{t.noForecast}</p>
      </div>

      {/* the two payments, never confused */}
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-xl border border-(--color-border) p-3 text-xs">
          <div className="font-semibold">{t.platformFee}</div>
          {quote && !quote.free ? (
            <div className="mt-1 space-y-0.5 text-(--color-fg-muted)">
              {quote.lines.map((l) => (
                <div key={l.description} className="flex justify-between gap-2">
                  <span>{l.description}</span>
                  <span className="tabular-nums">{centsToMoney(l.amountCents, quote.currency)}</span>
                </div>
              ))}
              {quote.taxCents > 0 && (
                <div className="flex justify-between gap-2">
                  <span>{d.billing.pricing.tax}</span>
                  <span className="tabular-nums">{centsToMoney(quote.taxCents, quote.currency)}</span>
                </div>
              )}
              <div className="flex justify-between gap-2 border-t border-(--color-border) pt-1 font-semibold text-(--color-fg)">
                <span>{d.common.total}</span>
                <span className="tabular-nums">{centsToMoney(quote.totalCents, quote.currency)}</span>
              </div>
              <p className="pt-1 text-[10px] text-(--color-fg-faint)">{t.platformFeeWhen}</p>
            </div>
          ) : (
            <p className="mt-1 leading-4 text-(--color-fg-muted)">{t.platformFeeNone}</p>
          )}
        </div>
        <div className="rounded-xl border border-(--color-mod-ads)/40 bg-(--color-warn-soft) p-3 text-xs">
          <div className="font-semibold text-(--color-warn)">{t.metaSpend}</div>
          <p className="mt-1 leading-4 text-(--color-fg-muted)">{t.metaSpendText}</p>
          <div className="mt-2">
            <AdBillingInline status={billingStatus} />
          </div>
        </div>
      </div>
    </div>
  );
}
