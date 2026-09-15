"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Bot, MessageCircle, Plus, Send, Sparkles } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";

/**
 * Agents tab — a top-level "3 agents at a glance" overview (Comment AI / DM
 * Admin AI / Campaign AI), matching how the owner thinks about the system,
 * over ONE shared underlying AIAgent (Comment/DM are two toggles on it,
 * sharing one knowledge base and persona on purpose — same business, same
 * facts) plus the Rules engine's COMMENT_RECEIVED rules for Campaign AI.
 * Deliberately not three separate agent records: nothing here is faked or
 * duplicated, it is the existing data presented the way the spec asks for.
 * Multiple real AIAgent rows (the data model allows it) still list below,
 * unaffected. Full settings live at /automation/agents/[id].
 */

interface Defaults {
  provider: "ANTHROPIC" | "OPENAI" | "GOOGLE";
  model: string;
}

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  autoReply: boolean;
  commentReplyEnabled: boolean;
  provider: "ANTHROPIC" | "OPENAI" | "GOOGLE";
  model: string;
  language: string | null;
  providerConfigured: boolean;
  account: { username: string; isDemo: boolean };
  _count: { conversations: number; documents: number };
}

interface CampaignCounts {
  total: number;
  active: number;
}

export function AgentsTab({ accountId }: { accountId: string }) {
  const { d } = useI18n();
  const [agents, setAgents] = React.useState<AgentRow[] | null>(null);
  const [defaults, setDefaults] = React.useState<Defaults | null>(null);
  const [campaigns, setCampaigns] = React.useState<CampaignCounts | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    const [agentsData, autoData] = await Promise.all([
      api<{ agents: AgentRow[]; defaults: Defaults }>(`/api/agents?accountId=${accountId}`, { silent: true }),
      api<{ automations: Array<{ trigger: string; enabled: boolean }> }>(`/api/automations?accountId=${accountId}`, { silent: true }),
    ]);
    setAgents(agentsData.agents);
    setDefaults(agentsData.defaults);
    const campaignRules = autoData.automations.filter((a) => a.trigger === "COMMENT_RECEIVED");
    setCampaigns({ total: campaignRules.length, active: campaignRules.filter((a) => a.enabled).length });
  }, [accountId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const primary = agents?.[0] ?? null;
  const others = agents?.slice(1) ?? [];

  async function toggleSurface(field: "commentReplyEnabled" | "autoReply", value: boolean) {
    if (!primary) return;
    const wakesAgent = value && !primary.enabled;
    setAgents(
      (prev) => prev?.map((a) => (a.id === primary.id ? { ...a, [field]: value, enabled: wakesAgent ? true : a.enabled } : a)) ?? null,
    );
    try {
      await api(`/api/agents/${primary.id}`, { method: "PATCH", json: { [field]: value, ...(wakesAgent ? { enabled: true } : {}) } });
      toast.success(value ? d.common.enabled : d.common.disabled);
    } catch {
      await load();
    }
  }

  async function toggleAgentMaster(agent: AgentRow, enabled: boolean) {
    setAgents((prev) => prev?.map((a) => (a.id === agent.id ? { ...a, enabled } : a)) ?? null);
    try {
      await api(`/api/agents/${agent.id}`, { method: "PATCH", json: { enabled } });
      toast.success(`${agent.name}: ${enabled ? d.common.enabled : d.common.disabled}`);
    } catch {
      await load();
    }
  }

  if (agents === null || campaigns === null) {
    return <p className="py-8 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>;
  }

  const o = d.automation.overview;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={15} /> {d.automation.agents.create}
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <OverviewCard
          icon={<MessageCircle size={16} />}
          title={o.commentTitle}
          description={o.commentDesc}
          active={Boolean(primary?.enabled && primary.commentReplyEnabled)}
          configured={Boolean(primary)}
          toggle={primary ? { checked: primary.commentReplyEnabled, onCheckedChange: (v) => toggleSurface("commentReplyEnabled", v) } : undefined}
          stats={primary ? [o.knowledgeSources(primary._count.documents)] : []}
          d={d}
          actionHref={primary ? `/automation/agents/${primary.id}` : undefined}
          onCreateClick={() => setCreateOpen(true)}
        />
        <OverviewCard
          icon={<Send size={16} />}
          title={o.dmTitle}
          description={o.dmDesc}
          active={Boolean(primary?.enabled && primary.autoReply)}
          configured={Boolean(primary)}
          toggle={primary ? { checked: primary.autoReply, onCheckedChange: (v) => toggleSurface("autoReply", v) } : undefined}
          stats={primary ? [d.automation.agents.replies(primary._count.conversations), o.knowledgeSources(primary._count.documents)] : []}
          d={d}
          actionHref={primary ? `/automation/agents/${primary.id}` : undefined}
          onCreateClick={() => setCreateOpen(true)}
        />
        <OverviewCard
          icon={<Sparkles size={16} />}
          title={o.campaignTitle}
          description={o.campaignDesc}
          active={campaigns.active > 0}
          configured={campaigns.total > 0}
          stats={[o.campaigns(campaigns.total), o.activeCampaigns(campaigns.active)]}
          d={d}
          actionHref="/automation?tab=rules"
        />
      </div>

      {primary?.account.isDemo && (
        <p className="text-xs text-(--color-fg-faint)">
          <Badge tone="warn">{d.shell.demo}</Badge>
        </p>
      )}

      {others.length > 0 && (
        <div className="space-y-2 pt-2">
          <p className="text-xs font-medium text-(--color-fg-muted)">{d.automation.tabs.agents}</p>
          <div className="grid gap-4 lg:grid-cols-2">
            {others.map((agent) => (
              <Card key={agent.id}>
                <CardHeader
                  icon={
                    <IconChip color="var(--color-mod-ai)">
                      <Bot size={16} />
                    </IconChip>
                  }
                  title={agent.name}
                  description={agent.description ?? undefined}
                  actions={
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-semibold ${agent.enabled ? "text-(--color-on)" : "text-(--color-off)"}`}>
                        {agent.enabled ? d.common.on : d.common.off}
                      </span>
                      <Switch checked={agent.enabled} onCheckedChange={(v) => toggleAgentMaster(agent, v)} />
                    </div>
                  }
                />
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    <Badge tone="accent">{agent.provider.toLowerCase()}</Badge>
                    <Badge>{agent.model}</Badge>
                    {!agent.providerConfigured && <Badge tone="danger">{d.dashboard.health.notConfigured}</Badge>}
                  </div>
                  <Button asChild size="sm" variant="secondary">
                    <Link href={`/automation/agents/${agent.id}`}>{d.automation.agents.openSettings}</Link>
                  </Button>
                </CardBody>
              </Card>
            ))}
          </div>
        </div>
      )}

      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} accountId={accountId} defaults={defaults} onCreated={load} />
    </div>
  );
}

function OverviewCard({
  icon,
  title,
  description,
  active,
  configured,
  toggle,
  stats,
  d,
  actionHref,
  onCreateClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  /** Drives the status badge/dot — "working" vs "off"/"not configured". */
  active: boolean;
  /** Is there anything real behind this card yet (an agent exists / a rule exists)? */
  configured: boolean;
  toggle?: { checked: boolean; onCheckedChange: (v: boolean) => void };
  stats: string[];
  d: Dictionary;
  actionHref?: string;
  onCreateClick?: () => void;
}) {
  const o = d.automation.overview;
  const statusLabel = !configured ? o.notConfigured : active ? o.active : o.off;
  const statusTone = !configured ? "default" : active ? "ok" : "default";

  return (
    <Card>
      <CardHeader
        icon={
          <IconChip color="var(--color-mod-ai)">
            {icon}
          </IconChip>
        }
        title={title}
        description={description}
        actions={
          toggle ? (
            <div className="flex items-center gap-2">
              <span className={`text-[10px] font-semibold ${active ? "text-(--color-on)" : "text-(--color-off)"}`}>
                {active ? d.common.on : d.common.off}
              </span>
              <Switch checked={toggle.checked} onCheckedChange={toggle.onCheckedChange} />
            </div>
          ) : (
            <Badge tone={statusTone}>{statusLabel}</Badge>
          )
        }
      />
      <CardBody className="space-y-3">
        <div className="flex flex-wrap gap-1.5 text-xs">
          {!configured && toggle && <Badge tone="warn">{o.notConfigured}</Badge>}
          {stats.map((s) => (
            <Badge key={s}>{s}</Badge>
          ))}
        </div>
        {actionHref ? (
          <Button asChild size="sm" variant="secondary">
            <Link href={actionHref}>{o.configure}</Link>
          </Button>
        ) : (
          onCreateClick && (
            <Button size="sm" variant="secondary" onClick={onCreateClick}>
              <Plus size={13} /> {d.automation.agents.create}
            </Button>
          )
        )}
      </CardBody>
    </Card>
  );
}

function CreateAgentDialog({
  open,
  onOpenChange,
  accountId,
  defaults,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
  defaults: Defaults | null;
  onCreated: () => Promise<void>;
}) {
  const { d } = useI18n();
  const [name, setName] = React.useState("");
  const [provider, setProvider] = React.useState<"ANTHROPIC" | "OPENAI" | "GOOGLE">(defaults?.provider ?? "OPENAI");
  const [model, setModel] = React.useState(defaults?.model ?? "");
  // the configured provider/model arrive after the first render
  React.useEffect(() => {
    if (defaults) {
      setProvider(defaults.provider);
      setModel((m) => m || defaults.model);
    }
  }, [defaults]);
  const [language, setLanguage] = React.useState(d.langName);
  const [systemPrompt, setSystemPrompt] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/agents", {
        method: "POST",
        json: {
          accountId,
          name,
          provider,
          model: model.trim() || undefined,
          language: language.trim() || undefined,
          systemPrompt,
        },
      });
      toast.success(d.common.saved);
      onOpenChange(false);
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={d.automation.agents.create}>
        <form onSubmit={submit} className="space-y-3">
          <Field label={d.automation.agents.newName}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={d.automation.agents.newNamePh}
              maxLength={120}
              required
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={d.automation.agents.providerLabel}>
              <Select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
                {(["ANTHROPIC", "OPENAI", "GOOGLE"] as const).map((p) => (
                  <option key={p} value={p}>
                    {d.automation.agents.providers[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={d.automation.agents.model}>
              <Input value={model} onChange={(e) => setModel(e.target.value)} maxLength={100} />
            </Field>
          </div>
          <Field label={d.automation.agents.language}>
            <Input value={language} onChange={(e) => setLanguage(e.target.value)} maxLength={60} />
          </Field>
          <Field label={d.automation.agents.systemPrompt}>
            <Textarea
              rows={4}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              minLength={10}
              required
            />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {d.common.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? d.common.saving : d.automation.agents.create}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
