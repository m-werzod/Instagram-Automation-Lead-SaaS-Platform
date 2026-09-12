"use client";

import * as React from "react";
import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Bot,
  DollarSign,
  Instagram,
  Megaphone,
  ScrollText,
  ShieldCheck,
  Users,
  Wallet,
} from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { centsToMoney, formatDate } from "@/lib/utils";

/**
 * Cross-account admin dashboard (spec §20). Every figure comes straight from
 * /api/admin/overview, which computes them from real rows — no placeholders.
 */

interface Overview {
  users: { total: number; byRole: Record<string, number> };
  accounts: { connected: number; total: number };
  campaigns: { active: number; total: number };
  agents: { active: number; total: number };
  leads: { total: number; qualified: number; won: number; last7d: number };
  adSpend: Record<string, number>;
  billing: { spentCents: number; currency: string; failedCount: number } | null;
  system: { deadJobs: number; failedWebhooks: number; tokenIssues: number; recentFailures24h: number };
  recentActivity: Array<{
    id: string;
    action: string;
    resourceType: string | null;
    success: boolean;
    error: string | null;
    createdAt: string;
    admin: { login: string; name: string } | null;
  }>;
}

export default function AdminOverviewPage() {
  const { d } = useI18n();
  const t = d.adminOverview;
  const [data, setData] = React.useState<Overview | null>(null);

  React.useEffect(() => {
    api<Overview>("/api/admin/overview", { silent: true })
      .then(setData)
      .catch(() => undefined);
  }, []);

  if (!data) return <div className="py-20 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</div>;

  const hasSystemIssue = data.system.deadJobs > 0 || data.system.failedWebhooks > 0 || data.system.tokenIssues > 0;
  const spendEntries = Object.entries(data.adSpend);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title={t.title}
        description={t.subtitle}
        accent="var(--color-mod-system)"
        actions={
          <Button asChild variant="secondary" size="sm">
            <Link href="/settings?tab=admins">{t.goToUsers}</Link>
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={<Users size={18} />}
          color="var(--color-mod-system)"
          label={t.users}
          value={String(data.users.total)}
          sub={`${data.users.byRole.OWNER ?? 0} ${t.owners} · ${data.users.byRole.ADMIN ?? 0} ${t.admins} · ${data.users.byRole.USER ?? 0} ${t.restrictedUsers}`}
        />
        <Stat
          icon={<Instagram size={18} />}
          color="var(--color-mod-instagram)"
          label={t.accounts}
          value={String(data.accounts.total)}
          sub={`${data.accounts.connected} ${t.connected}`}
        />
        <Stat
          icon={<Megaphone size={18} />}
          color="var(--color-mod-ads)"
          label={t.campaigns}
          value={String(data.campaigns.total)}
          sub={`${data.campaigns.active} ${t.active}`}
        />
        <Stat
          icon={<Bot size={18} />}
          color="var(--color-mod-ai)"
          label={t.agents}
          value={String(data.agents.total)}
          sub={`${data.agents.active} ${t.active}`}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat icon={<Users size={18} />} color="var(--color-mod-leads)" label={t.leads} value={String(data.leads.total)} sub={`${data.leads.qualified} ${t.qualified} · ${data.leads.won} ${t.won}`} />
        <Stat icon={<Activity size={18} />} color="var(--color-mod-leads)" label={t.last7d} value={String(data.leads.last7d)} />
        <Stat
          icon={<Wallet size={18} />}
          color="var(--color-info)"
          label={t.platformRevenue}
          value={data.billing ? centsToMoney(data.billing.spentCents, data.billing.currency) : "—"}
          sub={data.billing && data.billing.failedCount > 0 ? `${data.billing.failedCount} ${t.failedPayments}` : undefined}
        />
        <Card className="relative overflow-hidden">
          <span className="absolute inset-x-0 top-0 h-1" style={{ background: "var(--color-warn)" }} aria-hidden />
          <CardBody className="pt-4">
            <IconChip color="var(--color-warn)" size={36}><DollarSign size={18} /></IconChip>
            <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-(--color-fg-faint)">{t.adSpend}</div>
            {spendEntries.length === 0 ? (
              <div className="mt-0.5 text-sm text-(--color-fg-muted)">{t.noSpendYet}</div>
            ) : (
              <div className="mt-0.5 space-y-0.5">
                {spendEntries.map(([currency, cents]) => (
                  <div key={currency} className="text-lg font-bold tabular-nums">{centsToMoney(Math.round(cents * 100), currency)}</div>
                ))}
              </div>
            )}
            <div className="mt-1 text-[10px] leading-4 text-(--color-fg-faint)">{t.adSpendHint}</div>
          </CardBody>
        </Card>
      </div>

      <Card className={hasSystemIssue ? "border-(--color-warn)/40" : undefined}>
        <CardHeader
          icon={<IconChip color={hasSystemIssue ? "var(--color-warn)" : "var(--color-ok)"}><ShieldCheck size={16} /></IconChip>}
          title={t.systemHealth}
        />
        <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <HealthStat label={t.deadJobs} value={data.system.deadJobs} />
          <HealthStat label={t.failedWebhooks} value={data.system.failedWebhooks} />
          <HealthStat label={t.tokenIssues} value={data.system.tokenIssues} />
          <HealthStat label={t.recentFailures} value={data.system.recentFailures24h} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          icon={<IconChip color="var(--color-mod-system)"><ScrollText size={16} /></IconChip>}
          title={t.recentActivity}
          actions={
            <Button asChild size="sm" variant="ghost">
              <Link href="/audit-logs">{t.goToAuditLog}</Link>
            </Button>
          }
        />
        <CardBody className="p-0">
          <ul className="divide-y divide-(--color-border)">
            {data.recentActivity.map((ev) => (
              <li key={ev.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-mono">{ev.action}</span>
                  {ev.admin && <span className="text-(--color-fg-faint)"> · {ev.admin.login}</span>}
                  {!ev.success && ev.error && <span className="text-(--color-danger)"> · {ev.error}</span>}
                </span>
                {!ev.success && <Badge tone="danger"><AlertTriangle size={10} /> failed</Badge>}
                <span className="shrink-0 text-(--color-fg-faint)">{formatDate(ev.createdAt)}</span>
              </li>
            ))}
            {data.recentActivity.length === 0 && <li className="px-4 py-8 text-center text-(--color-fg-muted)">—</li>}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}

function Stat({ icon, color, label, value, sub }: { icon: React.ReactNode; color: string; label: string; value: string; sub?: string }) {
  return (
    <Card className="relative overflow-hidden">
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: color }} aria-hidden />
      <CardBody className="pt-4">
        <IconChip color={color} size={36}>{icon}</IconChip>
        <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-(--color-fg-faint)">{label}</div>
        <div className="mt-0.5 text-lg font-bold tabular-nums">{value}</div>
        {sub && <div className="text-[11px] text-(--color-fg-faint)">{sub}</div>}
      </CardBody>
    </Card>
  );
}

function HealthStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-(--color-panel-2) px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-(--color-fg-faint)">{label}</div>
      <div className={`text-lg font-bold tabular-nums ${value > 0 ? "text-(--color-danger)" : ""}`}>{value}</div>
    </div>
  );
}
