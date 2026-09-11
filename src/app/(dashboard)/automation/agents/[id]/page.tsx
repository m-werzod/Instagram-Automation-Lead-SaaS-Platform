"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Bot, Hash, MessageSquareText, SlidersHorizontal, Smile, Thermometer, Trash2, Wrench } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleRow } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";

/**
 * Agent settings (spec §8, §10, §34). Every toggle maps to a real runtime
 * guard in src/lib/agent/runtime.ts — none of them is decorative.
 */

interface AgentDetail {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  provider: "ANTHROPIC" | "OPENAI" | "GOOGLE";
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  tone: string | null;
  language: string | null;
  businessContext: string | null;
  salesStrategy: string | null;
  conversationRules: string | null;
  escalationRules: string | null;
  autoReply: boolean;
  leadQualification: boolean;
  knowledgeEnabled: boolean;
  humanHandoffEnabled: boolean;
  autoFollowUp: boolean;
  commentReplyEnabled: boolean;
  maxRepliesPerUserPerHour: number;
  allowedTools: string[];
  defaultLeadFlowId: string | null;
  account: { id: string; username: string };
}

interface ToolInfo {
  id: string;
  risk: "READ" | "WRITE" | "HIGH_RISK";
  description: string;
}

export default function AgentSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { d } = useI18n();
  const [agent, setAgent] = React.useState<AgentDetail | null>(null);
  const [flows, setFlows] = React.useState<Array<{ id: string; name: string; enabled: boolean }>>([]);
  const [tools, setTools] = React.useState<ToolInfo[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    const data = await api<{ agent: AgentDetail; flows: Array<{ id: string; name: string; enabled: boolean }> }>(
      `/api/agents/${id}`,
      { silent: true },
    );
    setAgent(data.agent);
    setFlows(data.flows);
    const list = await api<{ availableTools: ToolInfo[] }>(`/api/agents?accountId=${data.agent.accountId}`, {
      silent: true,
    });
    setTools(list.availableTools);
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Partial<AgentDetail>, message?: string) {
    if (!agent) return;
    setBusy(true);
    try {
      const data = await api<{ agent: AgentDetail }>(`/api/agents/${agent.id}`, { method: "PATCH", json: patch });
      setAgent((prev) => (prev ? { ...prev, ...data.agent } : prev));
      toast.success(message ?? d.common.saved);
    } finally {
      setBusy(false);
    }
  }

  async function removeAgent() {
    if (!agent) return;
    setBusy(true);
    try {
      await api(`/api/agents/${agent.id}`, { method: "DELETE" });
      toast.success(d.common.done);
      router.push("/automation");
    } finally {
      setBusy(false);
    }
  }

  if (!agent) {
    return <p className="py-20 text-center text-sm text-[--color-fg-muted]">{d.common.loading}</p>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <Link href="/automation">
            <ArrowLeft size={14} /> {d.common.back}
          </Link>
        </Button>
        <div className="flex items-center gap-3">
          <IconChip color="var(--color-mod-ai)" size={40}>
            <Bot size={20} />
          </IconChip>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-semibold leading-tight">
              <span className="truncate">{agent.name}</span>
              <Badge tone={agent.enabled ? "ok" : "default"}>{agent.enabled ? d.common.on : d.common.off}</Badge>
            </h1>
            <p className="text-xs text-[--color-fg-muted]">
              @{agent.account.username} · {agent.model}
            </p>
          </div>
        </div>
      </div>

      {/* master switch — the agent does nothing while OFF */}
      <Card className={agent.enabled ? "border-[--color-ok]/40" : undefined}>
        <CardBody className="py-1">
          <ToggleRow
            label={agent.enabled ? d.common.enabled : d.common.disabled}
            description={d.automation.subtitle}
            checked={agent.enabled}
            onCheckedChange={(v) => save({ enabled: v })}
            onLabel={d.common.on}
            offLabel={d.common.off}
          />
        </CardBody>
      </Card>

      {/* behavior toggles — each enforced in the reply pipeline */}
      <Card>
        <CardHeader
          icon={
            <IconChip color="var(--color-mod-ai)">
              <SlidersHorizontal size={16} />
            </IconChip>
          }
          title={d.automation.agents.behavior}
        />
        <CardBody className="divide-y divide-[--color-border]">
          <ToggleRow
            label={d.automation.agents.autoReply}
            checked={agent.autoReply}
            onCheckedChange={(v) => save({ autoReply: v })}
            onLabel={d.common.on}
            offLabel={d.common.off}
          />
          <ToggleRow
            label={d.automation.agents.leadQualification}
            checked={agent.leadQualification}
            onCheckedChange={(v) => save({ leadQualification: v })}
            onLabel={d.common.on}
            offLabel={d.common.off}
          />
          <ToggleRow
            label={d.automation.agents.knowledgeEnabled}
            checked={agent.knowledgeEnabled}
            onCheckedChange={(v) => save({ knowledgeEnabled: v })}
            onLabel={d.common.on}
            offLabel={d.common.off}
          />
          <ToggleRow
            label={d.automation.agents.humanHandoff}
            checked={agent.humanHandoffEnabled}
            onCheckedChange={(v) => save({ humanHandoffEnabled: v })}
            onLabel={d.common.on}
            offLabel={d.common.off}
          />
          <ToggleRow
            label={d.automation.agents.commentReply}
            checked={agent.commentReplyEnabled}
            onCheckedChange={(v) => save({ commentReplyEnabled: v })}
            onLabel={d.common.on}
            offLabel={d.common.off}
          />
        </CardBody>
      </Card>

      {/* model & limits */}
      <Card>
        <CardHeader
          icon={
            <IconChip color="var(--color-mod-ai)">
              <Bot size={16} />
            </IconChip>
          }
          title={d.automation.agents.model}
        />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <Field label={d.dashboard.health.ai}>
            <Select value={agent.provider} onChange={(e) => save({ provider: e.target.value as AgentDetail["provider"] })}>
              <option value="ANTHROPIC">Claude (Anthropic)</option>
              <option value="OPENAI">OpenAI</option>
              <option value="GOOGLE">Google (Gemini)</option>
            </Select>
          </Field>
          <SaveOnBlurInput
            label={d.automation.agents.model}
            ariaLabel={d.automation.agents.model}
            value={agent.model}
            onSave={(v) => save({ model: v })}
          />
          <SaveOnBlurInput
            label={
              <span className="inline-flex items-center gap-1">
                <Thermometer size={13} aria-hidden /> 0–2
              </span>
            }
            ariaLabel="temperature"
            value={String(agent.temperature)}
            onSave={(v) => {
              const n = Number(v);
              if (Number.isFinite(n) && n >= 0 && n <= 2) void save({ temperature: n });
              else toast.error(d.landing.invalidValue);
            }}
          />
          <SaveOnBlurInput
            label={
              <span className="inline-flex items-center gap-1">
                <Hash size={13} aria-hidden /> 64–8192
              </span>
            }
            ariaLabel="max tokens"
            value={String(agent.maxTokens)}
            onSave={(v) => {
              const n = Math.round(Number(v));
              if (Number.isFinite(n) && n >= 64 && n <= 8192) void save({ maxTokens: n });
              else toast.error(d.landing.invalidValue);
            }}
          />
          <SaveOnBlurInput
            label={d.automation.agents.language}
            ariaLabel={d.automation.agents.language}
            value={agent.language ?? ""}
            onSave={(v) => save({ language: v || null })}
          />
          <SaveOnBlurInput
            label={
              <span className="inline-flex items-center gap-1">
                <Smile size={13} aria-hidden />
              </span>
            }
            ariaLabel="tone"
            value={agent.tone ?? ""}
            onSave={(v) => save({ tone: v || null })}
          />
          <SaveOnBlurInput
            label={d.automation.agents.maxPerHour}
            ariaLabel={d.automation.agents.maxPerHour}
            value={String(agent.maxRepliesPerUserPerHour)}
            onSave={(v) => {
              const n = Math.round(Number(v));
              if (Number.isFinite(n) && n >= 1 && n <= 200) void save({ maxRepliesPerUserPerHour: n });
              else toast.error(d.landing.invalidValue);
            }}
          />
          <Field label={d.automation.rules.actions.start_lead_flow}>
            <Select value={agent.defaultLeadFlowId ?? ""} onChange={(e) => save({ defaultLeadFlowId: e.target.value || null })}>
              <option value="">{d.common.none}</option>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {!f.enabled ? ` (${d.common.disabled.toLowerCase()})` : ""}
                </option>
              ))}
            </Select>
          </Field>
        </CardBody>
      </Card>

      {/* prompts — business context is the only permitted source of facts */}
      <Card>
        <CardHeader
          icon={
            <IconChip color="var(--color-mod-ai)">
              <MessageSquareText size={16} />
            </IconChip>
          }
          title={d.automation.agents.prompts}
        />
        <CardBody className="space-y-4">
          <PromptEditor
            label={d.automation.agents.systemPrompt}
            value={agent.systemPrompt}
            rows={5}
            required
            onSave={(v) => save({ systemPrompt: v })}
          />
          <PromptEditor
            label={d.automation.agents.businessContext}
            hint={d.automation.agents.businessContextHint}
            value={agent.businessContext ?? ""}
            rows={6}
            onSave={(v) => save({ businessContext: v || null })}
          />
          <PromptEditor
            label={d.automation.agents.salesStrategy}
            value={agent.salesStrategy ?? ""}
            rows={3}
            onSave={(v) => save({ salesStrategy: v || null })}
          />
          <PromptEditor
            label={d.automation.agents.conversationRules}
            value={agent.conversationRules ?? ""}
            rows={3}
            onSave={(v) => save({ conversationRules: v || null })}
          />
          <PromptEditor
            label={d.automation.agents.escalationRules}
            value={agent.escalationRules ?? ""}
            rows={3}
            onSave={(v) => save({ escalationRules: v || null })}
          />
        </CardBody>
      </Card>

      {/* tool permissions (spec §34) — tool ids and risk levels are technical identifiers */}
      <Card>
        <CardHeader
          icon={
            <IconChip color="var(--color-mod-ai)">
              <Wrench size={16} />
            </IconChip>
          }
          title={d.common.actions}
        />
        <CardBody className="divide-y divide-[--color-border]">
          {tools.map((tool) => (
            <ToggleRow
              key={tool.id}
              label={tool.id}
              description={`${tool.risk} · ${tool.description}`}
              danger={tool.risk === "HIGH_RISK"}
              checked={agent.allowedTools.includes(tool.id)}
              onCheckedChange={(v) => {
                const next = v ? [...agent.allowedTools, tool.id] : agent.allowedTools.filter((t) => t !== tool.id);
                void save({ allowedTools: next });
              }}
              onLabel={d.common.on}
              offLabel={d.common.off}
            />
          ))}
        </CardBody>
      </Card>

      {/* danger zone */}
      <Card className="border-[--color-danger]/40">
        <CardHeader title={d.automation.agents.dangerZone} />
        <CardBody className="flex justify-end">
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            <Trash2 size={14} /> {d.automation.agents.deleteAgent}
          </Button>
        </CardBody>
      </Card>

      {busy && <p className="text-xs text-[--color-fg-faint]">{d.common.saving}</p>}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent title={d.automation.agents.deleteAgent}>
          <p className="text-sm text-[--color-fg-muted]">{d.common.confirmDelete(agent.name)}</p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
              {d.common.cancel}
            </Button>
            <Button variant="danger" disabled={busy} onClick={removeAgent}>
              {d.common.delete}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SaveOnBlurInput({
  label,
  ariaLabel,
  value,
  onSave,
}: {
  label: React.ReactNode;
  ariaLabel: string;
  value: string;
  onSave: (v: string) => void;
}) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);
  return (
    <div>
      <div className="mb-1.5 block text-xs font-medium text-[--color-fg-muted]">{label}</div>
      <Input
        aria-label={ariaLabel}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local !== value) onSave(local);
        }}
      />
    </div>
  );
}

function PromptEditor({
  label,
  hint,
  value,
  rows,
  onSave,
  required,
}: {
  label: string;
  hint?: string;
  value: string;
  rows: number;
  onSave: (v: string) => void;
  required?: boolean;
}) {
  const { d } = useI18n();
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);
  const dirty = local !== value;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[--color-fg-muted]">{label}</span>
        <Button size="sm" variant={dirty ? "default" : "ghost"} disabled={!dirty || (required && !local.trim())} onClick={() => onSave(local)}>
          {d.common.save}
        </Button>
      </div>
      {hint && <p className="mb-1.5 text-[11px] leading-4 text-[--color-fg-faint]">{hint}</p>}
      <Textarea rows={rows} value={local} onChange={(e) => setLocal(e.target.value)} />
    </div>
  );
}
