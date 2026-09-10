"use client";

import * as React from "react";
import Link from "next/link";
import { api } from "@/lib/client/api";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { StatusDot, Badge } from "@/components/ui/badge";
import { useAccounts } from "@/components/shell/account-context";
import { Button } from "@/components/ui/button";

interface Health {
  status: string;
  components: {
    database: { healthy: boolean; latencyMs: number | null };
    queue: { healthy: boolean; pending?: number; failed?: number; dead?: number; oldestPendingAgeSec?: number | null };
    email: { configured: boolean; failedCount: number };
    meta: { configured: boolean; tokenIssues: number };
    ai: { provider: string; configured: boolean };
    webhooks: { lastEventAt: string | null; lastStatus: string | null };
    worker: { note: string; deadJobs: number };
  };
}

interface Summary {
  messages: { inbound: number; aiReplies: number; humanReplies: number };
  leads: { total: number; qualified: number; won: number; flowCompletions: number };
  conversations: { active: number };
  ai: { calls: number; estimatedCostUsd: number; inputTokens: number; outputTokens: number; avgLatencyMs: number | null };
}

export default function DashboardPage() {
  const { selected, accounts } = useAccounts();
  const [health, setHealth] = React.useState<Health | null>(null);
  const [summary, setSummary] = React.useState<Summary | null>(null);

  React.useEffect(() => {
    api<Health>("/api/health", { silent: true }).then(setHealth).catch(() => undefined);
  }, []);
  React.useEffect(() => {
    const q = selected ? `?accountId=${selected.id}&days=7` : "?days=7";
    api<Summary>(`/api/analytics/summary${q}`, { silent: true }).then(setSummary).catch(() => undefined);
  }, [selected]);

  const c = health?.components;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dashboard</h1>
        {accounts.length === 0 && (
          <Button asChild>
            <Link href="/settings/integrations/instagram">Connect Instagram</Link>
          </Button>
        )}
      </div>

      {/* system health (spec §38) */}
      <Card>
        <CardHeader title="System health" description="Live component status — click a card for details" />
        <CardBody className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          <HealthCard label="Database" ok={Boolean(c?.database.healthy)} detail={c?.database.latencyMs != null ? `${c.database.latencyMs}ms` : "—"} />
          <HealthCard
            label="Queue / Worker"
            ok={Boolean(c?.queue.healthy)}
            warn={(c?.queue.pending ?? 0) > 50 || (c?.queue.failed ?? 0) > 0}
            detail={c ? `${c.queue.pending ?? 0} pending · ${c.queue.dead ?? 0} dead` : "—"}
          />
          <HealthCard label="Meta API" ok={Boolean(c?.meta.configured)} warn={(c?.meta.tokenIssues ?? 0) > 0}
            detail={c?.meta.configured ? (c.meta.tokenIssues ? `${c.meta.tokenIssues} token issue(s)` : "configured") : "not configured"} />
          <HealthCard label="AI Provider" ok={Boolean(c?.ai.configured)} detail={c ? `${c.ai.provider}${c.ai.configured ? "" : " (no key)"}` : "—"} />
          <HealthCard label="Email (SMTP)" ok={Boolean(c?.email.configured)} warn={(c?.email.failedCount ?? 0) > 0}
            detail={c?.email.configured ? (c.email.failedCount ? `${c.email.failedCount} failed` : "configured") : "not configured"} />
          <HealthCard label="Webhooks" ok={Boolean(c?.webhooks.lastEventAt)}
            detail={c?.webhooks.lastEventAt ? new Date(c.webhooks.lastEventAt).toLocaleTimeString() : "no events yet"} />
        </CardBody>
      </Card>

      {/* 7-day numbers */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Inbound messages (7d)" value={summary?.messages.inbound} />
        <Stat label="AI replies (7d)" value={summary?.messages.aiReplies} />
        <Stat label="Leads (7d)" value={summary?.leads.total} />
        <Stat
          label="AI cost (7d, est.)"
          value={summary ? `$${(summary.ai.estimatedCostUsd ?? 0).toFixed(2)}` : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Connected accounts" actions={<Button asChild variant="secondary" size="sm"><Link href="/instagram">Manage</Link></Button>} />
          <CardBody className="space-y-2">
            {accounts.length === 0 && (
              <p className="text-sm text-[--color-fg-muted]">
                No Instagram accounts connected yet. Start in{" "}
                <Link className="text-[--color-accent] underline" href="/settings/integrations/instagram">
                  Integrations
                </Link>
                .
              </p>
            )}
            {accounts.map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-md border border-[--color-border] px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  @{a.username}
                  {a.isDemo && <Badge tone="warn">DEMO</Badge>}
                  <Badge tone="default">{a.connectionMode === "INSTAGRAM_LOGIN" ? "Instagram Login" : "Facebook Login"}</Badge>
                </div>
                <StatusDot ok={a.status === "CONNECTED"} warn={a.status === "ERROR"} label={a.status} />
              </div>
            ))}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Quick actions" />
          <CardBody className="grid grid-cols-2 gap-2">
            <Button asChild variant="secondary"><Link href="/ai-agents">Configure AI agents</Link></Button>
            <Button asChild variant="secondary"><Link href="/crm/lead-flows">Build a lead flow</Link></Button>
            <Button asChild variant="secondary"><Link href="/conversations">Open conversations</Link></Button>
            <Button asChild variant="secondary"><Link href="/settings">Global switches</Link></Button>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

function HealthCard({ label, ok, warn, detail }: { label: string; ok: boolean; warn?: boolean; detail?: string }) {
  return (
    <div className="rounded-md border border-[--color-border] bg-[--color-panel-2] px-3 py-2.5">
      <StatusDot ok={ok} warn={warn && ok} label={label} />
      <div className="mt-1 truncate text-[11px] text-[--color-fg-faint]">{detail ?? "—"}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode | undefined }) {
  return (
    <Card>
      <CardBody>
        <div className="text-[11px] uppercase tracking-wide text-[--color-fg-faint]">{label}</div>
        <div className="mt-1 text-xl font-semibold">{value ?? "…"}</div>
      </CardBody>
    </Card>
  );
}
