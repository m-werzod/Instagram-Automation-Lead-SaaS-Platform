"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  FlaskConical,
  Plus,
  Receipt,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Star,
  Trash2,
  Users,
  Wallet,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleRow } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { cn, centsToMoney, formatDate } from "@/lib/utils";
import { SUPPORTED_PRICING_CURRENCIES, type Pricing, type Quote } from "@/lib/billing/pricing";

/**
 * Billing — the platform's own service payments. Meta advertising spend never
 * appears here (Meta bills the ad account directly); the page says so.
 * Every number is a sum over real Payment rows; cards are display metadata
 * from the provider (brand, last4) — the platform never sees a card number.
 */

type Status = "PENDING" | "PROCESSING" | "REQUIRES_ACTION" | "SUCCEEDED" | "FAILED" | "CANCELED" | "REFUNDED";

interface Method {
  id: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
}

interface PaymentRow {
  id: string;
  kind: "CAMPAIGN_FEE" | "PLAN" | "MANUAL";
  description: string;
  amountCents: number;
  currency: string;
  status: Status;
  receiptUrl: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  attempts: number;
  dueAt: string | null;
  paidAt: string | null;
  failedAt: string | null;
  refundedAt: string | null;
  canceledAt: string | null;
  nextRetryAt: string | null;
  createdAt: string;
  invoice: { number: string; receiptUrl: string | null } | null;
  campaign: { id: string; name: string } | null;
}

interface Schedule {
  id: string;
  name: string;
  amountCents: number;
  currency: string;
  intervalDays: number;
  nextBillingAt: string;
  status: "ACTIVE" | "PAUSED" | "CANCELED";
  campaign: { id: string; name: string } | null;
}

interface Overview {
  configured: boolean;
  testMode: boolean;
  role: "OWNER" | "ADMIN" | "USER";
  pricing: Pricing;
  plan: Quote;
  customer: { id: string; autoPay: boolean; defaultPaymentMethodId: string | null; currency: string } | null;
  methods: Method[];
  totals: { spentCents: number; failedCount: number; currency: string };
  next: { schedule: Schedule | null; payment: PaymentRow | null };
  schedules: Schedule[];
  payments: PaymentRow[];
}

const TONE: Record<Status, "default" | "info" | "warn" | "ok" | "danger"> = {
  PENDING: "info",
  PROCESSING: "warn",
  REQUIRES_ACTION: "warn",
  SUCCEEDED: "ok",
  FAILED: "danger",
  CANCELED: "default",
  REFUNDED: "default",
};

export default function BillingPage() {
  const { d } = useI18n();
  return (
    <React.Suspense fallback={<div className="py-20 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</div>}>
      <BillingInner />
    </React.Suspense>
  );
}

function BillingInner() {
  const { d } = useI18n();
  const t = d.billing;
  const params = useSearchParams();
  const router = useRouter();
  const [data, setData] = React.useState<Overview | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<"mine" | "admin">("mine");

  const load = React.useCallback(async () => {
    const res = await api<Overview>("/api/billing/overview", { silent: true });
    setData(res);
  }, []);

  React.useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  // messages after a round trip to Stripe
  React.useEffect(() => {
    if (params.get("returned")) toast.success(t.returned);
    if (params.get("card") === "added") toast.success(t.cardAdded);
    if (params.get("canceled")) toast.message(t.canceled);
    if (params.toString()) router.replace("/billing", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function act(key: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(key);
    try {
      await fn();
      if (success) toast.success(success);
      await load();
    } catch {
      /* toast from api() */
    } finally {
      setBusy(null);
    }
  }

  async function addCard() {
    setBusy("add-card");
    try {
      const res = await api<{ url: string }>("/api/billing/methods", { method: "POST" });
      window.location.href = res.url;
    } catch {
      setBusy(null);
    }
  }

  async function portal() {
    setBusy("portal");
    try {
      const res = await api<{ url: string | null; reason: string | null }>("/api/billing/portal", { method: "POST" });
      if (res.url) window.location.href = res.url;
      else toast.error(res.reason ?? t.portalUnavailable);
    } finally {
      setBusy(null);
    }
  }

  async function payNow(p: PaymentRow, action: "pay" | "retry") {
    setBusy(p.id);
    try {
      const res = await api<{ payment: PaymentRow; checkoutUrl: string | null }>(`/api/billing/payments/${p.id}`, { method: "POST", json: { action, returnPath: "/billing" } });
      if (res.checkoutUrl) {
        window.location.href = res.checkoutUrl;
        return;
      }
      toast[res.payment.status === "SUCCEEDED" ? "success" : "message"](t.statuses[res.payment.status]);
      await load();
    } catch {
      /* toast from api() */
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <div className="py-20 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</div>;

  const staff = data.role !== "USER";
  const nextAmount = data.next.payment ?? null;
  const nextSchedule = data.next.schedule;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={t.title}
        description={t.subtitle}
        accent="var(--color-info)"
        actions={
          staff ? (
            <div className="inline-flex rounded-lg border border-(--color-border) bg-(--color-panel-2) p-0.5 text-xs">
              {(["mine", "admin"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTab(k)}
                  className={cn("rounded-md px-3 py-1.5 font-medium", tab === k ? "bg-(--color-surface-raised) shadow-sm" : "text-(--color-fg-muted)")}
                >
                  {k === "mine" ? t.mine : t.admin.title}
                </button>
              ))}
            </div>
          ) : undefined
        }
      />

      {!data.configured && (
        <div className="flex items-start gap-3 rounded-xl border border-(--color-warn)/30 bg-(--color-warn-soft) px-4 py-3 text-xs leading-5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-(--color-warn)" />
          <div>
            <p className="font-semibold text-(--color-warn)">{t.notConfigured}</p>
            <p className="text-(--color-fg-muted)">{staff ? t.notConfiguredStaff : t.notConfiguredUser}</p>
          </div>
        </div>
      )}
      {data.testMode && (
        <div className="flex items-center gap-2 rounded-xl border border-(--color-info)/30 bg-(--color-info-soft) px-4 py-2 text-xs font-medium text-(--color-info)">
          <FlaskConical size={14} /> {t.testMode}
        </div>
      )}

      {tab === "admin" && staff ? (
        <AdminBilling />
      ) : (
        <>
          {/* summary */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Summary icon={<Wallet size={18} />} color="var(--color-info)" label={t.spent} value={centsToMoney(data.totals.spentCents, data.totals.currency)} />
            <Summary
              icon={<CalendarClock size={18} />}
              color="var(--color-mod-ads)"
              label={t.nextPayment}
              value={nextAmount ? centsToMoney(nextAmount.amountCents, nextAmount.currency) : nextSchedule ? centsToMoney(nextSchedule.amountCents, nextSchedule.currency) : t.none}
              sub={nextAmount?.dueAt ? formatDate(nextAmount.dueAt) : nextSchedule ? formatDate(nextSchedule.nextBillingAt) : undefined}
            />
            <Summary
              icon={<XCircle size={18} />}
              color={data.totals.failedCount > 0 ? "var(--color-danger)" : "var(--color-mod-system)"}
              label={t.failed}
              value={String(data.totals.failedCount)}
            />
            <Card>
              <CardBody className="py-1">
                <ToggleRow
                  label={t.autoPay}
                  description={data.customer?.autoPay ? t.autoPayOn : data.methods.length === 0 ? t.autoPayNeedsCard : t.autoPayOff}
                  checked={Boolean(data.customer?.autoPay)}
                  disabled={!data.configured || busy === "autopay" || (!data.customer?.autoPay && data.methods.length === 0)}
                  onCheckedChange={(v) => void act("autopay", () => api("/api/billing/autopay", { method: "PATCH", json: { enabled: v } }), d.common.saved)}
                  onLabel={d.common.on}
                  offLabel={d.common.off}
                />
              </CardBody>
            </Card>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            {/* payment methods */}
            <Card>
              <CardHeader
                icon={<IconChip color="var(--color-info)"><CreditCard size={16} /></IconChip>}
                title={t.methods}
                description={t.addCardHint}
                actions={
                  <Button size="sm" disabled={!data.configured || busy === "add-card"} onClick={() => void addCard()}>
                    <Plus size={13} /> {t.addCard}
                  </Button>
                }
              />
              <CardBody className="space-y-2">
                {data.methods.length === 0 && <p className="py-4 text-center text-xs text-(--color-fg-muted)">{t.noMethods}</p>}
                {data.methods.map((m) => {
                  const isDefault = m.id === data.customer?.defaultPaymentMethodId;
                  return (
                    <div key={m.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-(--color-border) px-3 py-2">
                      <CreditCard size={16} className="text-(--color-fg-faint)" />
                      <span className="text-sm font-medium capitalize">{m.brand ?? "card"}</span>
                      <span className="font-mono text-sm">•••• {m.last4 ?? "????"}</span>
                      {m.expMonth && m.expYear && (
                        <span className="text-xs text-(--color-fg-faint)">
                          {t.expires} {String(m.expMonth).padStart(2, "0")}/{String(m.expYear).slice(-2)}
                        </span>
                      )}
                      {isDefault && <Badge tone="accent"><Star size={10} /> {t.default}</Badge>}
                      <div className="ml-auto flex items-center gap-1">
                        {!isDefault && (
                          <Button size="sm" variant="ghost" disabled={busy === m.id} onClick={() => void act(m.id, () => api("/api/billing/methods", { method: "PATCH", json: { methodId: m.id } }), d.common.saved)}>
                            {t.setDefault}
                          </Button>
                        )}
                        <Button size="icon" variant="ghost" disabled={busy === m.id} aria-label={t.remove} onClick={() => void act(m.id, () => api("/api/billing/methods", { method: "DELETE", json: { methodId: m.id } }), t.removed)}>
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {data.customer && (
                  <Button size="sm" variant="ghost" disabled={busy === "portal"} onClick={() => void portal()}>
                    <ExternalLink size={13} /> {t.manageInStripe}
                  </Button>
                )}
                <p className="flex items-start gap-1.5 pt-1 text-[11px] leading-4 text-(--color-fg-faint)">
                  <ShieldCheck size={12} className="mt-0.5 shrink-0" /> {t.security}
                </p>
              </CardBody>
            </Card>

            {/* upcoming */}
            <Card>
              <CardHeader icon={<IconChip color="var(--color-mod-ads)"><CalendarClock size={16} /></IconChip>} title={t.upcoming} />
              <CardBody className="space-y-2">
                {data.schedules.length === 0 && data.payments.filter((p) => p.status === "PENDING" || p.status === "FAILED" || p.status === "REQUIRES_ACTION").length === 0 && (
                  <p className="py-4 text-center text-xs text-(--color-fg-muted)">{t.none}</p>
                )}
                {data.schedules.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-(--color-border) px-3 py-2 text-xs">
                    <span className="font-medium">{s.name}</span>
                    <Badge tone={s.status === "ACTIVE" ? "ok" : "default"}>{s.status}</Badge>
                    <span className="text-(--color-fg-faint)">{t.every(s.intervalDays)}</span>
                    <span className="ml-auto font-semibold tabular-nums">{centsToMoney(s.amountCents, s.currency)}</span>
                    <span className="text-(--color-fg-faint)">{formatDate(s.nextBillingAt)}</span>
                  </div>
                ))}
                {data.payments
                  .filter((p) => p.status === "PENDING" || p.status === "FAILED" || p.status === "REQUIRES_ACTION")
                  .map((p) => (
                    <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-(--color-warn)/30 bg-(--color-warn-soft) px-3 py-2 text-xs">
                      <span className="min-w-0 flex-1 truncate font-medium">{p.description}</span>
                      <Badge tone={TONE[p.status]}>{t.statuses[p.status]}</Badge>
                      <span className="font-semibold tabular-nums">{centsToMoney(p.amountCents, p.currency)}</span>
                      <Button size="sm" disabled={!data.configured || busy === p.id} onClick={() => void payNow(p, p.status === "FAILED" ? "retry" : "pay")}>
                        {p.status === "FAILED" ? <RotateCcw size={12} /> : <CreditCard size={12} />} {p.status === "FAILED" ? t.retry : t.payNow}
                      </Button>
                      <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => void act(p.id, () => api(`/api/billing/payments/${p.id}`, { method: "POST", json: { action: "cancel" } }), t.canceled)}>
                        {t.cancelPayment}
                      </Button>
                    </div>
                  ))}
              </CardBody>
            </Card>
          </div>

          {/* history */}
          <Card>
            <CardHeader icon={<IconChip color="var(--color-info)"><Receipt size={16} /></IconChip>} title={t.history} />
            <CardBody className="p-0">
              {data.payments.length === 0 ? (
                <p className="px-4 py-8 text-center text-xs text-(--color-fg-muted)">{t.historyEmpty}</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-(--color-border) text-(--color-fg-faint)">
                      <tr>
                        <th className="px-4 py-2 font-medium">{t.date}</th>
                        <th className="px-4 py-2 font-medium">{t.description}</th>
                        <th className="px-4 py-2 font-medium">{t.amount}</th>
                        <th className="px-4 py-2 font-medium">{t.status}</th>
                        <th className="px-4 py-2 font-medium">{t.receipt}</th>
                        <th className="px-4 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {data.payments.map((p) => (
                        <tr key={p.id} className="border-b border-(--color-border) last:border-0">
                          <td className="whitespace-nowrap px-4 py-2 text-(--color-fg-muted)">{formatDate(p.paidAt ?? p.createdAt)}</td>
                          <td className="px-4 py-2">
                            <div className="font-medium">{p.description}</div>
                            <div className="text-[10px] text-(--color-fg-faint)">
                              {t.kinds[p.kind]}
                              {p.campaign ? ` · ${p.campaign.name}` : ""}
                              {p.failureMessage ? ` · ${p.failureMessage}` : ""}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-4 py-2 font-semibold tabular-nums">{centsToMoney(p.amountCents, p.currency)}</td>
                          <td className="px-4 py-2">
                            <Badge tone={TONE[p.status]}>{t.statuses[p.status]}</Badge>
                          </td>
                          <td className="px-4 py-2">
                            {p.receiptUrl || p.invoice?.receiptUrl ? (
                              <a href={p.receiptUrl ?? p.invoice?.receiptUrl ?? "#"} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-(--color-accent) underline-offset-2 hover:underline">
                                {p.invoice?.number ?? t.receipt} <ExternalLink size={11} />
                              </a>
                            ) : (
                              <span className="text-(--color-fg-faint)">{p.invoice?.number ?? "—"}</span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <div className="inline-flex items-center gap-1">
                              {p.status === "FAILED" && (
                                <Button size="sm" variant="secondary" disabled={!data.configured || busy === p.id} onClick={() => void payNow(p, "retry")}>
                                  <RotateCcw size={12} /> {t.retry}
                                </Button>
                              )}
                              {(p.status === "PENDING" || p.status === "PROCESSING" || p.status === "REQUIRES_ACTION") && (
                                <Button size="sm" variant="ghost" disabled={busy === p.id} onClick={() => void act(p.id, () => api(`/api/billing/payments/${p.id}`, { method: "POST", json: { action: "sync" } }))}>
                                  <RefreshCw size={12} /> {t.sync}
                                </Button>
                              )}
                              <PaymentDetail payment={p} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>

          {data.role === "OWNER" && <PricingCard pricing={data.pricing} onSaved={load} />}
        </>
      )}
    </div>
  );
}

function Summary({ icon, color, label, value, sub }: { icon: React.ReactNode; color: string; label: string; value: string; sub?: string }) {
  return (
    <Card className="relative overflow-hidden">
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: color }} aria-hidden />
      <CardBody className="pt-4">
        <div className="flex items-center justify-between gap-2">
          <IconChip color={color} size={36}>{icon}</IconChip>
        </div>
        <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-(--color-fg-faint)">{label}</div>
        <div className="mt-0.5 truncate text-lg font-bold tabular-nums">{value}</div>
        {sub && <div className="text-[11px] text-(--color-fg-faint)">{sub}</div>}
      </CardBody>
    </Card>
  );
}

/* ---------- timeline ---------- */

function PaymentDetail({ payment }: { payment: PaymentRow }) {
  const { d } = useI18n();
  const t = d.billing;
  const [open, setOpen] = React.useState(false);
  const steps: Array<{ label: string; at: string | null; tone: "ok" | "warn" | "danger" | "default"; done: boolean }> = [
    { label: t.timeline.created, at: payment.createdAt, tone: "default", done: true },
    { label: t.timeline.due, at: payment.dueAt, tone: "default", done: Boolean(payment.dueAt && new Date(payment.dueAt) <= new Date()) },
  ];
  if (payment.status === "PROCESSING") steps.push({ label: t.timeline.processing, at: null, tone: "warn", done: true });
  if (payment.paidAt) steps.push({ label: t.timeline.succeeded, at: payment.paidAt, tone: "ok", done: true });
  if (payment.failedAt) steps.push({ label: t.timeline.failed, at: payment.failedAt, tone: "danger", done: true });
  if (payment.status === "FAILED") steps.push({ label: payment.nextRetryAt ? t.timeline.retry : t.timeline.manual, at: payment.nextRetryAt, tone: "warn", done: false });
  if (payment.canceledAt) steps.push({ label: t.timeline.canceled, at: payment.canceledAt, tone: "default", done: true });
  if (payment.refundedAt) steps.push({ label: t.timeline.refunded, at: payment.refundedAt, tone: "default", done: true });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        {t.details}
      </Button>
      <DialogContent title={t.timeline.title} description={`${payment.description} · ${centsToMoney(payment.amountCents, payment.currency)}`}>
        <ol className="space-y-2">
          {steps.map((s, i) => (
            <li key={i} className="flex items-start gap-3 text-sm">
              <span className={cn("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full", s.done ? "bg-(--color-ok-soft) text-(--color-ok)" : "bg-(--color-panel-2) text-(--color-fg-faint)")}>
                {s.done ? <CheckCircle2 size={12} /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
              </span>
              <div className="min-w-0">
                <div className={cn("font-medium", s.tone === "danger" && "text-(--color-danger)", s.tone === "ok" && "text-(--color-ok)")}>{s.label}</div>
                <div className="text-[11px] text-(--color-fg-faint)">{s.at ? formatDate(s.at) : "—"}</div>
              </div>
            </li>
          ))}
        </ol>
        {payment.failureMessage && <p className="mt-3 rounded-lg bg-(--color-danger-soft) px-3 py-2 text-xs text-(--color-danger)">{payment.failureMessage}</p>}
        <p className="mt-3 text-[11px] text-(--color-fg-faint)">
          {t.attempts}: {payment.attempts}
        </p>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- pricing (OWNER) ---------- */

function PricingCard({ pricing, onSaved }: { pricing: Pricing; onSaved: () => Promise<void> }) {
  const { d } = useI18n();
  const t = d.billing.pricing;
  const [form, setForm] = React.useState({
    currency: pricing.currency,
    campaignFee: String(pricing.campaignFeeCents / 100),
    campaignFeePercent: String(pricing.campaignFeePercent),
    planName: pricing.planName ?? "",
    planAmount: String(pricing.planAmountCents / 100),
    planIntervalDays: String(pricing.planIntervalDays),
    taxPercent: String(pricing.taxPercent),
  });
  const [busy, setBusy] = React.useState(false);
  const free = pricing.campaignFeeCents === 0 && pricing.campaignFeePercent === 0 && pricing.planAmountCents === 0;

  async function save() {
    setBusy(true);
    try {
      await api("/api/billing/pricing", {
        method: "PUT",
        json: {
          currency: form.currency,
          campaignFeeCents: Math.round(Number(form.campaignFee) * 100) || 0,
          campaignFeePercent: Number(form.campaignFeePercent) || 0,
          planName: form.planName.trim() || null,
          planAmountCents: Math.round(Number(form.planAmount) * 100) || 0,
          planIntervalDays: Math.round(Number(form.planIntervalDays)) || 30,
          taxPercent: Number(form.taxPercent) || 0,
        },
      });
      toast.success(t.saved);
      await onSaved();
    } catch {
      /* toast from api() */
    } finally {
      setBusy(false);
    }
  }

  const f = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((prev) => ({ ...prev, [k]: e.target.value }));

  return (
    <Card>
      <CardHeader icon={<IconChip color="var(--color-mod-system)"><Wallet size={16} /></IconChip>} title={t.title} description={t.subtitle} />
      <CardBody className="space-y-3">
        {free && <p className="rounded-lg bg-(--color-panel-2) px-3 py-2 text-xs text-(--color-fg-muted)">{t.free}</p>}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t.currency} hint={t.currencyHint}>
            <Select value={form.currency} onChange={(e) => setForm((prev) => ({ ...prev, currency: e.target.value }))}>
              {SUPPORTED_PRICING_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`${t.campaignFee} (${form.currency})`}>
            <Input type="number" min="0" step="0.01" value={form.campaignFee} onChange={f("campaignFee")} />
          </Field>
          <Field label={t.campaignFeePercent}>
            <Input type="number" min="0" max="100" step="0.1" value={form.campaignFeePercent} onChange={f("campaignFeePercent")} />
          </Field>
          <Field label={t.planName}>
            <Input value={form.planName} onChange={f("planName")} placeholder="Pro" />
          </Field>
          <Field label={`${t.planAmount} (${form.currency})`}>
            <Input type="number" min="0" step="0.01" value={form.planAmount} onChange={f("planAmount")} />
          </Field>
          <Field label={t.planInterval}>
            <Input type="number" min="1" max="365" value={form.planIntervalDays} onChange={f("planIntervalDays")} />
          </Field>
          <Field label={t.tax}>
            <Input type="number" min="0" max="100" step="0.1" value={form.taxPercent} onChange={f("taxPercent")} />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? d.common.saving : t.save}
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/* ---------- admin: everyone's payments ---------- */

interface AdminData {
  days: number;
  byStatus: Array<{ status: Status; currency: string; _sum: { amountCents: number | null }; _count: number }>;
  recent: Array<PaymentRow & { customer: { admin: { id: string; login: string; name: string }; autoPay: boolean } }>;
  customers: number;
  failedOpen: number;
  dueSoon: Array<Schedule & { customer: { admin: { login: string; name: string }; autoPay: boolean } }>;
}

function AdminBilling() {
  const { d } = useI18n();
  const t = d.billing;
  const [data, setData] = React.useState<AdminData | null>(null);
  React.useEffect(() => {
    api<AdminData>("/api/billing/admin", { silent: true }).then(setData).catch(() => undefined);
  }, []);
  if (!data) return <p className="py-10 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>;

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-3">
        <Summary icon={<Users size={18} />} color="var(--color-mod-system)" label={t.admin.customers} value={String(data.customers)} />
        <Summary icon={<XCircle size={18} />} color={data.failedOpen > 0 ? "var(--color-danger)" : "var(--color-mod-system)"} label={t.admin.failedOpen} value={String(data.failedOpen)} />
        <Summary icon={<CalendarClock size={18} />} color="var(--color-mod-ads)" label={t.admin.dueSoon} value={String(data.dueSoon.length)} />
      </div>
      <Card>
        <CardHeader title={t.admin.byStatus} />
        <CardBody className="flex flex-wrap gap-2">
          {data.byStatus.length === 0 && <span className="text-xs text-(--color-fg-muted)">{t.historyEmpty}</span>}
          {data.byStatus.map((row) => (
            <span key={`${row.status}-${row.currency}`} className="inline-flex items-center gap-2 rounded-lg border border-(--color-border) px-3 py-1.5 text-xs">
              <Badge tone={TONE[row.status]}>{t.statuses[row.status]}</Badge>
              <span className="font-semibold tabular-nums">{centsToMoney(row._sum.amountCents ?? 0, row.currency)}</span>
              <span className="text-(--color-fg-faint)">× {row._count}</span>
            </span>
          ))}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title={t.admin.recent} />
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-(--color-border) text-(--color-fg-faint)">
                <tr>
                  <th className="px-4 py-2 font-medium">{t.date}</th>
                  <th className="px-4 py-2 font-medium">{t.admin.user}</th>
                  <th className="px-4 py-2 font-medium">{t.description}</th>
                  <th className="px-4 py-2 font-medium">{t.amount}</th>
                  <th className="px-4 py-2 font-medium">{t.status}</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((p) => (
                  <tr key={p.id} className="border-b border-(--color-border) last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 text-(--color-fg-muted)">{formatDate(p.paidAt ?? p.createdAt)}</td>
                    <td className="px-4 py-2">
                      <span className="font-medium">{p.customer.admin.name}</span> <span className="font-mono text-(--color-fg-faint)">{p.customer.admin.login}</span>
                      {p.customer.autoPay && <Badge tone="ok" className="ml-1">auto</Badge>}
                    </td>
                    <td className="px-4 py-2">{p.description}</td>
                    <td className="whitespace-nowrap px-4 py-2 font-semibold tabular-nums">{centsToMoney(p.amountCents, p.currency)}</td>
                    <td className="px-4 py-2">
                      <Badge tone={TONE[p.status]}>{t.statuses[p.status]}</Badge>
                    </td>
                  </tr>
                ))}
                {data.recent.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-(--color-fg-muted)">{t.historyEmpty}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
