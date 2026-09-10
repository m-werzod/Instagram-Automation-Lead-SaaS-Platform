"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useAccounts } from "@/components/shell/account-context";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Plus } from "lucide-react";

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

export default function AgentsPage() {
  const { selected } = useAccounts();
  const [agents, setAgents] = React.useState<AgentRow[] | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!selected) return;
    const data = await api<{ agents: AgentRow[] }>(`/api/agents?accountId=${selected.id}`, { silent: true });
    setAgents(data.agents);
  }, [selected]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function toggle(agent: AgentRow, enabled: boolean) {
    setAgents((prev) => prev?.map((a) => (a.id === agent.id ? { ...a, enabled } : a)) ?? null);
    try {
      await api(`/api/agents/${agent.id}`, { method: "PATCH", json: { enabled } });
      toast.success(`Agent "${agent.name}" is now ${enabled ? "ON" : "OFF"}`);
    } catch {
      await load(); // revert on failure
    }
  }

  if (!selected) return <p className="text-sm text-[--color-fg-muted]">Connect an Instagram account first.</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="AI Agents"
        description={`Assistants that reply to Instagram DMs for @${selected.username} automatically. Each agent has its own instructions, its own knowledge, and an explicit list of what it is allowed to do. New agents start switched OFF.`}
        accent="var(--color-mod-ai)"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> New agent
          </Button>
        }
      />

      {agents?.length === 0 && (
        <EmptyState
          title="No AI agents yet"
          description="An agent reads incoming Instagram messages and replies using the instructions and business facts you give it. It stays switched off until you turn it on."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> Create your first agent
            </Button>
          }
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {agents?.map((agent) => (
          <Card key={agent.id}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  {agent.name}
                  {agent.account.isDemo && <Badge tone="warn">DEMO</Badge>}
                </span>
              }
              description={agent.description ?? undefined}
              actions={
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-semibold ${agent.enabled ? "text-[--color-on]" : "text-[--color-off]"}`}>
                    {agent.enabled ? "ON" : "OFF"}
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
                <Badge>{agent._count.conversations} conversations</Badge>
                {!agent.providerConfigured && (
                  <Badge tone="danger" title="Add the provider API key to .env">
                    API key missing
                  </Badge>
                )}
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link href={`/ai-agents/${agent.id}`}>Configure</Link>
              </Button>
            </CardBody>
          </Card>
        ))}
      </div>

      <CreateAgentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        accountId={selected.id}
        onCreated={load}
      />
    </div>
  );
}

function CreateAgentDialog({
  open,
  onOpenChange,
  accountId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accountId: string;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = React.useState("Instagram Sales Agent");
  const [provider, setProvider] = React.useState<"ANTHROPIC" | "OPENAI" | "GOOGLE">("ANTHROPIC");
  const [model, setModel] = React.useState("");
  const [language, setLanguage] = React.useState("Uzbek");
  const [tone, setTone] = React.useState("Professional + conversational");
  const [systemPrompt, setSystemPrompt] = React.useState(
    "You are the Instagram sales assistant for this business. Answer briefly and helpfully, qualify interested users, and guide them to registration when they want to proceed.",
  );
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/agents", {
        method: "POST",
        json: { accountId, name, provider, model: model || undefined, language, tone, systemPrompt },
      });
      toast.success("Agent created (OFF by default) — open Configure to finish setup");
      onOpenChange(false);
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Create AI agent" description="The agent starts disabled. Provider API keys stay server-side.">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="AI Provider">
              <Select value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
                <option value="ANTHROPIC">Claude (Anthropic)</option>
                <option value="OPENAI">OpenAI</option>
                <option value="GOOGLE">Google (Gemini)</option>
              </Select>
            </Field>
            <Field label="Model" hint="Leave empty for the provider default">
              <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="provider default" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Language">
              <Input value={language} onChange={(e) => setLanguage(e.target.value)} />
            </Field>
            <Field label="Tone">
              <Input value={tone} onChange={(e) => setTone(e.target.value)} />
            </Field>
          </div>
          <Field label="System prompt">
            <Textarea rows={4} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} required />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create agent"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
