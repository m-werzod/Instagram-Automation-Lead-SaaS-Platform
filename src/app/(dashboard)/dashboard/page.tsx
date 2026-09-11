"use client";

import * as React from "react";
import Link from "next/link";
import {
  Instagram,
  MousePointerClick,
  Power,
  Users,
  ArrowRight,
  Megaphone,
  Activity,
  BarChart3,
} from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { useAccounts } from "@/components/shell/account-context";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Dashboard — answers, within seconds: is Instagram connected, is the Lead
 * Button live, is automation on, and are leads coming in. Detailed numbers
 * (formerly the separate Analytics page) live below with a range selector.
 */

interface Summary {
  days: number;
  messages: { inbound: number; aiReplies: number; humanReplies: number };
  leads: { total: number; qualified: number; won: number };
  ai: { estimatedCostUsd: number; calls: number };
  campaigns: { active: number; total: number };
  email: Record<string, number>;
}

interface HealthComponents {
  database?: { healthy: boolean };
  queue?: { healthy: boolean };
  email?: { configured: boolean; failedCount: number };
  ai?: { configured: boolean };
  webhooks?: { lastEventAt: string | null };
}

interface LeadRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  source: string;
  status: string;
  createdAt: string;
}

interface LeadButtonState {
  enabled: boolean;
  leadsCount: number;
}

export default function DashboardPage() {
  const { d, locale } = useI18n();
  const { selected, loading: accountsLoading } = useAccounts();

  const [days, setDays] = React.useState(7);
  const [summary, setSummary] = React.useState<Summary | null>(null);
  const [today, setToday] = React.useState<Summary | null>(null);
  const [health, setHealth] = React.useState<HealthComponents | null>(null);
  const [master, setMaster] = React.useState<boolean | null>(null);
  const [leadButton, setLeadButton] = React.useState<LeadButtonState | null | "none">(null);
  const [recentLeads, setRecentLeads] = React.useState<LeadRow[]>([]);

  React.useEffect(() => {
    void (async () => {
      try {
        const h = await api<{ components?: HealthComponents }>("/api/health", { silent: true });
        setHealth(h.components ?? {});
      } catch { /* ignore */ }
      try {
        const s = await api<{ settings: { masterAutomationEnabled: boolean } }>("/api/settings/global", { silent: true });
        setMaster(s.settings.masterAutomationEnabled);
      } catch { /* ignore */ }
    })();
  }, []);

  React.useEffect(() => {
    if (!selected) return;
    void (async () => {
      try {
        const [s, t, leads, lb] = await Promise.all([
          api<Summary>(`/api/analytics/summary?accountId=${selected.id}&days=${days}`, { silent: true }),
          api<Summary>(`/api/analytics/summary?accountId=${selected.id}&days=1`, { silent: true }),
          api<{ leads: LeadRow[] }>(`/api/leads?accountId=${selected.id}`, { silent: true }),
          api<{ leadButton: LeadButtonState | null }>(`/api/lead-button?accountId=${selected.id}`, { silent: true }),
        ]);
        setSummary(s);
        setToday(t);
        setRecentLeads(leads.leads.slice(0, 6));
        setLeadButton(lb.leadButton ?? "none");
      } catch { /* individual toasts suppressed on dashboard boot */ }
    })();
  }, [selected?.id, days, selected]);

  const dateFmt = React.useMemo(
    () => new Intl.DateTimeFormat(locale === "uz" ? "uz-Latn-UZ" : locale === "ru" ? "ru-RU" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
    [locale],
  );

  return (
    <>
      <PageHeader title={d.dashboard.title} description={d.dashboard.subtitle} accent="var(--color-mod-overview)" />

      {/* hero status row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {/* Instagram */}
        <HeroCard
          color="var(--color-mod-instagram)"
          icon={<Instagram size={18} />}
          label={d.dashboard.instagramCard}
          loading={accountsLoading}
          value={selected ? `@${selected.username}` : d.common.notConnected}
          state={selected ? (selected.status === "CONNECTED" ? "ok" : "danger") : "off"}
          stateLabel={selected ? d.instagram.status[selected.status] ?? selected.status : d.dashboard.notSetUp}
          href="/instagram"
          cta={selected ? d.common.view : d.dashboard.quick.connect}
        />
        {/* Lead Button */}
        <HeroCard
          color="var(--color-accent)"
          icon={<MousePointerClick size={18} />}
          label={d.dashboard.leadButtonCard}
          loading={leadButton === null && !!selected}
          value={
            leadButton === "none" || leadButton === null
              ? d.dashboard.notSetUp
              : leadButton.enabled
                ? d.dashboard.working
                : d.dashboard.disabledLabel
          }
          state={leadButton !== null && leadButton !== "none" ? (leadButton.enabled ? "ok" : "off") : "off"}
          stateLabel={
            leadButton !== null && leadButton !== "none"
              ? `${leadButton.leadsCount} ${d.nav.leads.split(" ")[0]?.toLowerCase()}`
              : d.dashboard.setUp
          }
          href="/lead-button"
          cta={leadButton === "none" ? d.dashboard.setUp : d.common.view}
        />
        {/* Automation master */}
        <HeroCard
          color="var(--color-mod-ai)"
          icon={<Power size={18} />}
          label={d.dashboard.automationCard}
          loading={master === null}
          value={master === null ? "…" : master ? d.shell.automationOn : d.shell.automationOff}
          state={master ? "ok" : "danger"}
          stateLabel={master ? d.common.on : d.common.off}
          href="/settings"
          cta={d.nav.settings}
        />
        {/* Leads today */}
        <HeroCard
          color="var(--color-mod-leads)"
          icon={<Users size={18} />}
          label={d.dashboard.leadsToday}
          loading={!today && !!selected}
          value={String(today?.leads.total ?? 0)}
          state={(today?.leads.total ?? 0) > 0 ? "ok" : "off"}
          stateLabel={`${d.common.days7}: ${summary?.leads.total ?? 0}`}
          href="/leads"
          cta={d.dashboard.viewAllLeads}
        />
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-3">
        {/* recent leads */}
        <Card className="lg:col-span-2">
          <CardHeader
            icon={<IconChip color="var(--color-mod-leads)"><Users size={16} /></IconChip>}
            title={d.dashboard.recentLeads}
            actions={
              <Button variant="ghost" size="sm" asChild>
                <Link href="/leads">{d.dashboard.viewAllLeads} <ArrowRight size={13} /></Link>
              </Button>
            }
          />
          <CardBody className="p-0">
            {recentLeads.length === 0 ? (
              <p className="px-4 py-10 text-center text-xs leading-5 text-(--color-fg-muted)">{d.dashboard.noLeadsYet}</p>
            ) : (
              <ul className="divide-y divide-(--color-border)">
                {recentLeads.map((l) => (
                  <li key={l.id}>
                    <Link href="/leads" className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-(--color-panel-2)">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-(--color-ok-soft) text-xs font-bold text-(--color-ok)">
                        {(l.name ?? "•").charAt(0).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{l.name ?? l.phone ?? l.email ?? "—"}</span>
                        <span className="block truncate text-[11px] text-(--color-fg-faint)">
                          {(d.leads.sources as Record<string, string>)[l.source] ?? l.source} · {dateFmt.format(new Date(l.createdAt))}
                        </span>
                      </span>
                      <Badge tone={l.status === "NEW" ? "accent" : l.status === "WON" ? "ok" : "default"}>
                        {(d.leads.statuses as Record<string, string>)[l.status] ?? l.status}
                      </Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* quick actions + system */}
        <div className="space-y-5">
          <Card>
            <CardHeader title={d.dashboard.quick.title} />
            <CardBody className="grid gap-2">
              {!selected && (
                <QuickAction href="/instagram" color="var(--color-mod-instagram)" icon={<Instagram size={15} />} label={d.dashboard.quick.connect} />
              )}
              <QuickAction href="/lead-button" color="var(--color-accent)" icon={<MousePointerClick size={15} />} label={d.dashboard.quick.leadButton} />
              <QuickAction href="/leads" color="var(--color-mod-leads)" icon={<Users size={15} />} label={d.dashboard.quick.viewLeads} />
              <QuickAction href="/campaigns" color="var(--color-mod-ads)" icon={<Megaphone size={15} />} label={d.dashboard.quick.createAd} />
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              icon={<IconChip color="var(--color-mod-system)"><Activity size={16} /></IconChip>}
              title={d.dashboard.health.title}
            />
            <CardBody className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
              <HealthRow label={d.dashboard.health.database} ok={health?.database?.healthy ?? false} okText={d.dashboard.health.ok} badText={d.dashboard.health.problem} />
              <HealthRow label={d.dashboard.health.queue} ok={health?.queue?.healthy ?? false} okText={d.dashboard.health.ok} badText={d.dashboard.health.problem} />
              <HealthRow
                label={d.dashboard.health.email}
                ok={health?.email?.configured ?? false}
                okText={d.dashboard.health.ok}
                badText={d.dashboard.health.notConfigured}
                warn={!(health?.email?.configured ?? false)}
              />
              <HealthRow
                label={d.dashboard.health.ai}
                ok={health?.ai?.configured ?? false}
                okText={d.dashboard.health.ok}
                badText={d.dashboard.health.notConfigured}
                warn={!(health?.ai?.configured ?? false)}
              />
              <HealthRow label={d.dashboard.health.webhooks} ok={Boolean(health?.webhooks?.lastEventAt)} okText={d.dashboard.health.ok} badText="—" warn={!health?.webhooks?.lastEventAt} />
            </CardBody>
          </Card>
        </div>
      </div>

      {/* numbers (merged Analytics) */}
      <Card className="mt-5">
        <CardHeader
          icon={<IconChip color="var(--color-mod-overview)"><BarChart3 size={16} /></IconChip>}
          title={d.dashboard.stats.title}
          actions={
            <Select className="h-8 w-28 text-xs" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              <option value="7">{d.common.days7}</option>
              <option value="30">{d.common.days30}</option>
              <option value="90">{d.common.days90}</option>
            </Select>
          }
        />
        <CardBody className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <Stat label={d.dashboard.stats.inbound} value={summary?.messages.inbound ?? 0} />
          <Stat label={d.dashboard.stats.aiReplies} value={summary?.messages.aiReplies ?? 0} />
          <Stat label={d.dashboard.stats.leads} value={summary?.leads.total ?? 0} accent="var(--color-mod-leads)" />
          <Stat label={d.dashboard.stats.aiCost} value={`$${(summary?.ai.estimatedCostUsd ?? 0).toFixed(2)}`} />
          <Stat label={d.dashboard.stats.campaigns} value={summary?.campaigns.active ?? 0} accent="var(--color-mod-ads)" />
          <Stat label={d.dashboard.stats.emailsSent} value={summary?.email?.SENT ?? 0} />
        </CardBody>
      </Card>
    </>
  );
}

/* ---------- pieces ---------- */

function HeroCard({
  color,
  icon,
  label,
  value,
  state,
  stateLabel,
  href,
  cta,
  loading,
}: {
  color: string;
  icon: React.ReactNode;
  label: string;
  value: string;
  state: "ok" | "danger" | "off";
  stateLabel: string;
  href: string;
  cta: string;
  loading?: boolean;
}) {
  return (
    <Card className="relative overflow-hidden">
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: color }} aria-hidden />
      <CardBody className="pt-4">
        <div className="flex items-center justify-between gap-2">
          <IconChip color={color} size={36}>{icon}</IconChip>
          <Badge tone={state === "ok" ? "ok" : state === "danger" ? "danger" : "default"}>{stateLabel}</Badge>
        </div>
        <div className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-(--color-fg-faint)">{label}</div>
        <div className={cn("mt-0.5 truncate text-lg font-bold", loading && "animate-pulse text-(--color-fg-faint)")}>
          {loading ? "…" : value}
        </div>
        <Link href={href} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline" style={{ color }}>
          {cta} <ArrowRight size={12} />
        </Link>
      </CardBody>
    </Card>
  );
}

function QuickAction({ href, color, icon, label }: { href: string; color: string; icon: React.ReactNode; label: string }) {
  return (
    <Button variant="secondary" className="justify-start" asChild>
      <Link href={href}>
        <IconChip color={color} size={24}>{icon}</IconChip>
        {label}
      </Link>
    </Button>
  );
}

function HealthRow({ label, ok, okText, badText, warn }: { label: string; ok: boolean; okText: string; badText: string; warn?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", ok ? "bg-(--color-ok)" : warn ? "bg-(--color-warn)" : "bg-(--color-danger)")} />
      <span className="truncate text-(--color-fg-muted)">{label}</span>
      <span className={cn("ml-auto shrink-0 font-medium", ok ? "text-(--color-ok)" : warn ? "text-(--color-warn)" : "text-(--color-danger)")}>
        {ok ? okText : badText}
      </span>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="rounded-xl bg-(--color-panel-2) px-3 py-3">
      <div className="text-[11px] font-medium text-(--color-fg-muted)">{label}</div>
      <div className="mt-0.5 text-xl font-bold" style={accent ? { color: accent } : undefined}>{value}</div>
    </div>
  );
}
