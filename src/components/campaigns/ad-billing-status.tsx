"use client";

import { AlertTriangle, CheckCircle2, CreditCard, ExternalLink, HelpCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";

/**
 * "Pay Meta directly" (Path 1, decided 2026-09-13): Meta always bills the ad
 * account's OWN payment method — this platform never collects or forwards a
 * card for it. What we DO own is making that fact visible before it surprises
 * anyone: a read-only status from Meta, shown right where the user is about
 * to spend, with one link straight to Meta's real billing page.
 */

export interface AdBillingStatus {
  applicable: boolean;
  reason: string | null;
  billingUrl: string;
  status: {
    adAccountId: string;
    statusCode: number | null;
    statusLabel: string;
    readyToSpend: boolean;
    fundingSourceDisplay: string | null;
    disableReason: string | null;
  } | null;
}

/** Top-of-page banner — shown whenever an ad account is linked. */
export function AdBillingBanner({ status }: { status: AdBillingStatus | null }) {
  const { d } = useI18n();
  const t = d.campaigns.billingStatus;
  if (!status || !status.applicable) return null;
  const s = status.status;

  if (s?.readyToSpend) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-(--color-ok)/30 bg-(--color-ok-soft) px-4 py-2.5 text-xs leading-5 text-(--color-ok)">
        <CheckCircle2 size={14} className="shrink-0" />
        <span className="font-medium">{t.ready}</span>
        {s.fundingSourceDisplay && <span className="text-(--color-fg-muted)">{s.fundingSourceDisplay}</span>}
        <span className="ml-auto shrink-0 text-[10px] text-(--color-fg-faint)">{t.billedByMeta}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-(--color-warn)/30 bg-(--color-warn-soft) px-4 py-3 text-xs leading-5 text-(--color-warn)">
      <AlertTriangle size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{s ? t.notReady(s.statusLabel) : status.reason ?? t.unknown}</span>{" "}
        <span className="text-(--color-fg-muted)">
          {t.explain} {s?.adAccountId && <code className="font-mono">{s.adAccountId}</code>}
        </span>
      </span>
      <Button asChild size="sm" variant="secondary" className="shrink-0">
        <a href={status.billingUrl} target="_blank" rel="noreferrer">
          <CreditCard size={13} /> {t.openMetaBilling} <ExternalLink size={11} />
        </a>
      </Button>
    </div>
  );
}

/** Compact inline version for the wizard's review step. */
export function AdBillingInline({ status }: { status: AdBillingStatus | null }) {
  const { d } = useI18n();
  const t = d.campaigns.billingStatus;
  if (!status) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-(--color-fg-faint)">
        <HelpCircle size={12} /> {t.checking}
      </p>
    );
  }
  if (!status.applicable) return null;
  const s = status.status;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-(--color-panel-2) px-3 py-2 text-[11px] leading-4">
      {s?.readyToSpend ? (
        <>
          <CheckCircle2 size={13} className="shrink-0 text-(--color-ok)" />
          <span className="text-(--color-fg)">{t.ready}</span>
          {s.fundingSourceDisplay && <span className="text-(--color-fg-faint)">— {s.fundingSourceDisplay}</span>}
        </>
      ) : (
        <>
          <AlertTriangle size={13} className="shrink-0 text-(--color-warn)" />
          <span className="text-(--color-fg)">{s ? t.notReady(s.statusLabel) : status.reason ?? t.unknown}</span>
          <a href={status.billingUrl} target="_blank" rel="noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-1 font-semibold text-(--color-accent) underline-offset-2 hover:underline">
            {t.openMetaBilling} <ExternalLink size={10} />
          </a>
        </>
      )}
    </div>
  );
}
