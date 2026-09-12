"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Bot, Plus } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/page-header";

/** Agents tab — list, quick ON/OFF, create. Full settings live at /automation/agents/[id]. */

interface Defaults {
  provider: "ANTHROPIC" | "OPENAI" | "GOOGLE";
  model: string;
}

interface AgentRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  provider: "ANTHROPIC" | "OPENAI" | "GOOGLE";
  model: string;
  language: string | null;
  providerConfigured: boolean;
  account: { username: string; isDemo: boolean };
  _count: { conversations: number };
}

export function AgentsTab({ accountId }: { accountId: string }) {
  const { d } = useI18n();
  const [agents, setAgents] = React.useState<AgentRow[] | null>(null);
  const [defaults, setDefaults] = React.useState<Defaults | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    const data = await api<{ agents: AgentRow[]; defaults: Defaults }>(`/api/agents?accountId=${accountId}`, { silent: true });
    setAgents(data.agents);
    setDefaults(data.defaults);
  }, [accountId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function toggle(agent: AgentRow, enabled: boolean) {
    setAgents((prev) => prev?.map((a) => (a.id === agent.id ? { ...a, enabled } : a)) ?? null);
    try {
      await api(`/api/agents/${agent.id}`, { method: "PATCH", json: { enabled } });
      toast.success(`${agent.name}: ${enabled ? d.common.enabled : d.common.disabled}`);
    } catch {
      await load(); // revert on failure
    }
  }

  if (agents === null) {
    return <p className="py-8 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>;
  }

  return (
    <div className="space-y-4">
      {agents.length === 0 ? (
        <EmptyState
          icon={
            <IconChip color="var(--color-mod-ai)" size={48}>
              <Bot size={22} />
            </IconChip>
          }
          title={d.automation.agents.empty}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> {d.automation.agents.create}
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex justify-end">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> {d.automation.agents.create}
            </Button>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {agents.map((agent) => (
              <Card key={agent.id}>
                <CardHeader
                  icon={
                    <IconChip color="var(--color-mod-ai)">
                      <Bot size={16} />
                    </IconChip>
                  }
                  title={
                    <span className="flex items-center gap-2">
                      {agent.name}
                      {agent.account.isDemo && <Badge tone="warn">{d.shell.demo}</Badge>}
                    </span>
                  }
                  description={agent.description ?? undefined}
                  actions={
                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-semibold ${agent.enabled ? "text-(--color-on)" : "text-(--color-off)"}`}
                      >
                        {agent.enabled ? d.common.on : d.common.off}
                      </span>
                      <Switch checked={agent.enabled} onCheckedChange={(v) => toggle(agent, v)} />
                    </div>
                  }
                />
                <CardBody className="space-y-3">
                  <div className="flex flex-wrap gap-1.5 text-xs">
                    <Badge tone="accent">{agent.provider.toLowerCase()}</Badge>
                    <Badge>{agent.model}</Badge>
                    {agent.language && <Badge>{agent.language}</Badge>}
                    <Badge>{d.automation.agents.replies(agent._count.conversations)}</Badge>
                    {!agent.providerConfigured && <Badge tone="danger">{d.dashboard.health.notConfigured}</Badge>}
                  </div>
                  <Button asChild size="sm" variant="secondary">
                    <Link href={`/automation/agents/${agent.id}`}>{d.automation.agents.openSettings}</Link>
                  </Button>
                </CardBody>
              </Card>
            ))}
          </div>
        </>
      )}

      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} accountId={accountId} defaults={defaults} onCreated={load} />
    </div>
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
