"use client";

import * as React from "react";
import { api } from "@/lib/client/api";
import { useAccounts } from "@/components/shell/account-context";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";

/** Analytics (spec §28) — real data only; unavailable metrics say why. */

interface Summary {
  days: number;
  messages: { inbound: number; aiReplies: number; humanReplies: number };
  conversations: { active: number };
  leads: { total: number; qualified: number; won: number; flowCompletions: number };
  ai: {
    calls: number;
    failures: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    avgLatencyMs: number | null;
  };
  responseTime: { avgFirstReplyMs: number | null };
  campaigns: { total: number; active: number; drafts: number; aiDrafted: number };
  email: Record<string, number>;
  instagramInsights: Record<string, number> | null;
  insightsUnavailableReason: string | null;
}

export default function AnalyticsPage() {
  const { selected } = useAccounts();
  const [days, setDays] = React.useState(7);
  const [data, setData] = React.useState<Summary | null>(null);

  React.useEffect(() => {
    if (!selected) return;
    api<Summary>(`/api/analytics/summary?accountId=${selected.id}&days=${days}`, { silent: true })
      .then(setData)
      .catch(() => undefined);
  }, [selected, days]);

  if (!selected) return <p className="text-sm text-[--color-fg-muted]">Connect an Instagram account first.</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Analytics"
        description={`Real numbers only for @${selected.username} — counted from your own data plus Meta Insights where Instagram provides it. Nothing here is estimated or invented; unavailable figures say why.`}
        accent="var(--color-mod-overview)"
        actions={
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
          </Select>
        }
      />

      <Section title="Messaging">
        <Metric label="Inbound messages" value={data?.messages.inbound} />
        <Metric label="AI responses" value={data?.messages.aiReplies} />
        <Metric label="Human responses" value={data?.messages.humanReplies} />
        <Metric label="Active conversations" value={data?.conversations.active} />
        <Metric
          label="Avg first response"
          value={data?.responseTime.avgFirstReplyMs != null ? `${(data.responseTime.avgFirstReplyMs / 1000).toFixed(1)}s` : "—"}
        />
      </Section>

      <Section title="Leads & registrations">
        <Metric label="Leads" value={data?.leads.total} />
        <Metric label="Qualified+" value={data?.leads.qualified} />
        <Metric label="Won" value={data?.leads.won} />
        <Metric label="Flow completions" value={data?.leads.flowCompletions} />
      </Section>

      <Section title="AI usage & cost">
        <Metric label="AI calls" value={data?.ai.calls} />
        <Metric label="Failures" value={data?.ai.failures} tone={data && data.ai.failures > 0 ? "danger" : undefined} />
        <Metric label="Input tokens" value={data?.ai.inputTokens.toLocaleString()} />
        <Metric label="Output tokens" value={data?.ai.outputTokens.toLocaleString()} />
        <Metric label="Est. cost" value={data ? `$${data.ai.estimatedCostUsd.toFixed(3)}` : undefined} />
        <Metric label="Avg latency" value={data?.ai.avgLatencyMs != null ? `${data.ai.avgLatencyMs}ms` : "—"} />
      </Section>

      <Section title="Campaigns">
        <Metric label="Total" value={data?.campaigns.total} />
        <Metric label="Active (spending)" value={data?.campaigns.active} tone={data && data.campaigns.active > 0 ? "ok" : undefined} />
        <Metric label="Drafts" value={data?.campaigns.drafts} />
        <Metric label="AI-drafted" value={data?.campaigns.aiDrafted} />
      </Section>

      <Card>
        <CardHeader
          title="Instagram Insights (Meta)"
          description="Official account metrics (views era — 'impressions' is deprecated by Meta). Only real API data is shown."
        />
        <CardBody>
          {data?.instagramInsights ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {Object.entries(data.instagramInsights).map(([k, v]) => (
                <Metric key={k} label={k.replace(/_/g, " ")} value={v.toLocaleString()} />
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-[--color-fg-muted]">
              <Badge tone="warn">Unavailable</Badge>
              {data?.insightsUnavailableReason ?? "Loading…"}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Email delivery" />
        <CardBody className="flex gap-3">
          {data &&
            Object.entries(data.email).map(([status, count]) => (
              <Badge key={status} tone={status === "SENT" ? "ok" : status === "FAILED" ? "danger" : "warn"}>
                {status}: {count}
              </Badge>
            ))}
          {data && Object.keys(data.email).length === 0 && <span className="text-xs text-[--color-fg-muted]">No emails in this period.</span>}
        </CardBody>
      </Card>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} />
      <CardBody className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">{children}</CardBody>
    </Card>
  );
}

function Metric({ label, value, tone }: { label: string; value: React.ReactNode | undefined; tone?: "ok" | "danger" }) {
  return (
    <div className="rounded-md border border-[--color-border] bg-[--color-panel-2] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-[--color-fg-faint]">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold ${tone === "danger" ? "text-[--color-danger]" : tone === "ok" ? "text-[--color-ok]" : ""}`}>
        {value ?? "…"}
      </div>
    </div>
  );
}
