"use client";

import * as React from "react";
import { AlertTriangle, CheckCircle2, CreditCard, ExternalLink, Info, Loader2, ShieldCheck } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import type { AdBillingStatus } from "./ad-billing-status";

/**
 * Everything about advertising money that Meta actually lets a platform show or
 * change, in one place, so a targetolog does not have to leave to run a budget.
 *
 * What is here: the payment method Meta holds, the outstanding balance, spend to
 * date, and the spend cap — which is writable, and is a hard stop (Meta pauses
 * every campaign on the account when spending reaches it).
 *
 * What is deliberately NOT here: entering a card. Meta bills the ad account's
 * own payment method and exposes no API for another platform to add one or to
 * pay on the advertiser's behalf. Pretending otherwise would mean collecting
 * card details we could not use. The panel says so plainly and links to the one
 * page where that single setup step happens.
 */

function formatMoney(minor: number | null, currency: string | null, locale: string): string {
  if (minor === null) return "—";
  const amount = minor / 100;
  try {
    return new Intl.NumberFormat(locale, {
      style: currency ? "currency" : "decimal",
      currency: currency ?? undefined,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // An unexpected currency code must not blank the whole panel.
    return `${amount.toFixed(2)} ${currency ?? ""}`.trim();
  }
}

export function AdMoneyPanel({
  status,
  accountId,
  onChanged,
}: {
  status: AdBillingStatus | null;
  accountId: string | null;
  onChanged: () => void | Promise<void>;
}) {
  const { d, locale } = useI18n();
  const t = d.campaigns.billingStatus;

  const [editing, setEditing] = React.useState(false);
  const [amount, setAmount] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  if (!status || !status.applicable || !status.status) return null;
  const s = status.status;
  const money = (v: number | null) => formatMoney(v, s.currency, locale);

  async function change(body: Record<string, unknown>) {
    if (!accountId) return;
    setBusy(true);
    try {
      await api(`/api/instagram/accounts/${accountId}/ad-spend-cap`, { method: "POST", json: body });
      toast.success(t.capSaved);
      setEditing(false);
      await onChanged();
    } catch {
      /* api() already surfaced the reason */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title={t.panelTitle}
        description={`${t.adAccount}: ${s.name ?? s.adAccountId}`}
        actions={
          s.readyToSpend ? (
            <Badge tone="ok">
              <CheckCircle2 className="h-3 w-3" /> {t.ready}
            </Badge>
          ) : (
            <Badge tone="warn">
              <AlertTriangle className="h-3 w-3" /> {s.statusLabel}
            </Badge>
          )
        }
      />

      <div className="space-y-4 p-4 pt-0">
        <div className="grid gap-3 sm:grid-cols-3">
          <Figure
            label={t.paymentMethod}
            value={s.fundingSourceDisplay ?? t.noPaymentMethod}
            muted={!s.fundingSourceDisplay}
            icon={<CreditCard className="h-3.5 w-3.5" />}
          />
          <Figure label={t.spent} value={money(s.amountSpentMinor)} />
          <Figure label={t.balance} value={money(s.balanceMinor)} />
        </div>

        {s.isPrepay && <p className="text-xs text-(--color-fg-muted)">{t.prepay}</p>}

        {/* ---- spend cap: the one money control Meta lets us write ---- */}
        <div className="rounded-lg border border-(--color-border) p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-(--color-fg-muted)">{t.spendCap}</p>
              {s.spendCapMinor === null ? (
                <p className="text-sm text-(--color-fg-muted)">{t.noSpendCap}</p>
              ) : (
                <p className="text-sm font-medium">
                  {money(s.spendCapMinor)}
                  {s.spendCapRemainingMinor !== null && (
                    <span className="ml-2 text-xs font-normal text-(--color-fg-muted)">
                      {money(s.spendCapRemainingMinor)} {t.capRemaining}
                    </span>
                  )}
                </p>
              )}
            </div>

            {!editing && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => setEditing(true)}>
                  {s.spendCapMinor === null ? t.setCap : t.changeCap}
                </Button>
                {s.spendCapMinor !== null && (
                  <>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change({ action: "reset" })}>
                      {t.resetCap}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void change({ action: "remove" })}>
                      {t.removeCap}
                    </Button>
                  </>
                )}
              </div>
            )}
          </div>

          {editing && (
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(amount);
                if (Number.isFinite(n) && n > 0) void change({ action: "set", amount: n });
              }}
            >
              <label className="flex-1 text-xs">
                <span className="mb-1.5 block font-medium text-(--color-fg-muted)">
                  {t.capAmount} {s.currency ? `(${s.currency})` : ""}
                </span>
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  autoFocus
                />
              </label>
              <Button type="submit" size="sm" disabled={busy || !(Number(amount) > 0)}>
                {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
                {d.common.save}
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                {d.common.cancel}
              </Button>
            </form>
          )}

          <p className="mt-2 flex items-start gap-1.5 text-xs text-(--color-fg-muted)">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {editing ? t.capHelp : s.spendCapMinor !== null ? t.resetHelp : t.capHelp}
          </p>
        </div>

        {/* ---- the one thing that happens at Meta, said plainly ---- */}
        <div className="rounded-lg border border-(--color-border) bg-(--color-panel-2) p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <ShieldCheck className="h-3.5 w-3.5 text-(--color-fg-muted)" />
            {t.whereCardLives}
          </p>
          <p className="mt-1 text-xs leading-5 text-(--color-fg-muted)">{t.whereCardLivesBody}</p>
          <Button asChild size="sm" variant="secondary" className="mt-2">
            <a href={status.billingUrl} target="_blank" rel="noreferrer noopener">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              {t.openMetaBilling}
            </a>
          </Button>
        </div>
      </div>
    </Card>
  );
}

function Figure({
  label,
  value,
  muted,
  icon,
}: {
  label: string;
  value: string;
  muted?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-(--color-panel-2) px-3 py-2">
      <p className="flex items-center gap-1.5 text-xs text-(--color-fg-muted)">
        {icon}
        {label}
      </p>
      <p className={`mt-0.5 text-sm ${muted ? "text-(--color-fg-muted)" : "font-medium"}`}>{value}</p>
    </div>
  );
}
