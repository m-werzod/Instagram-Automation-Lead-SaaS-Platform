"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleRow } from "@/components/ui/switch";
import { Field, Input, Select, Textarea } from "@/components/ui/input";

/** Full agent configuration (spec §8, §10, §34). Every toggle maps to a real runtime guard. */

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

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [agent, setAgent] = React.useState<AgentDetail | null>(null);
  const [flows, setFlows] = React.useState<Array<{ id: string; name: string; enabled: boolean }>>([]);
  const [tools, setTools] = React.useState<ToolInfo[]>([]);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const data = await api<{ agent: AgentDetail; flows: Array<{ id: string; name: string; enabled: boolean }> }>(
      `/api/agents/${id}`,
      { silent: true },
    );
    setAgent(data.agent);
    setFlows(data.flows);
    const list = await api<{ availableTools: ToolInfo[] }>(`/api/agents?accountId=${data.agent.accountId}`, { silent: true });
    setTools(list.availableTools);
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Partial<AgentDetail>, message = "Saved") {
    if (!agent) return;
    setBusy(true);
    try {
      const data = await api<{ agent: AgentDetail }>(`/api/agents/${agent.id}`, { method: "PATCH", json: patch });
      setAgent((prev) => (prev ? { ...prev, ...data.agent } : prev));
      toast.success(message);
    } finally {
      setBusy(false);
    }
  }

  if (!agent) return <p className="text-sm text-[--color-fg-muted]">Loading…</p>;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            {agent.name}
            <Badge tone={agent.enabled ? "ok" : "default"}>{agent.enabled ? "ON" : "OFF"}</Badge>
          </h1>
          <p className="text-xs text-[--color-fg-muted]">@{agent.account.username}</p>
        </div>
        <div className="flex gap-2">
          <Button variant={agent.enabled ? "danger" : "success"} onClick={() => save({ enabled: !agent.enabled }, agent.enabled ? "Agent turned OFF" : "Agent turned ON")}>
            {agent.enabled ? "Turn OFF" : "Turn ON"}
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              if (!confirm(`Delete agent "${agent.name}"? Conversations stay, the agent config is removed.`)) return;
              await api(`/api/agents/${agent.id}`, { method: "DELETE" });
              toast.success("Agent deleted");
              router.push("/ai-agents");
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      {/* behavior toggles — each enforced in src/lib/agent/runtime.ts */}
      <Card>
        <CardHeader title="Behavior switches" description="Each switch is enforced in the reply pipeline — not decorative" />
        <CardBody className="divide-y divide-[--color-border]">
          <ToggleRow label="Auto Reply" description="Reply automatically to inbound DMs (within Meta's 24h window)" checked={agent.autoReply} onCheckedChange={(v) => save({ autoReply: v })} />
          <ToggleRow label="Lead Qualification" description="Actively qualify users and push toward the lead flow" checked={agent.leadQualification} onCheckedChange={(v) => save({ leadQualification: v })} />
          <ToggleRow label="Knowledge Base" description="Retrieve business documents before answering" checked={agent.knowledgeEnabled} onCheckedChange={(v) => save({ knowledgeEnabled: v })} />
          <ToggleRow label="Human Handoff" description="Allow the agent to escalate conversations to admins" checked={agent.humanHandoffEnabled} onCheckedChange={(v) => save({ humanHandoffEnabled: v })} />
          <ToggleRow label="Automatic Follow-up" description="Not yet implemented — Meta's 24h window makes proactive follow-ups impossible without the user messaging again; kept OFF" checked={agent.autoFollowUp} onCheckedChange={() => toast.info("Follow-ups outside the 24h window are not permitted by Meta policy — see docs/META_API.md §3.")} disabled />
          <ToggleRow label="Comment Reply" description="Let automations reply to comments with this agent's account (comment webhooks require Advanced Access in production)" checked={agent.commentReplyEnabled} onCheckedChange={(v) => save({ commentReplyEnabled: v })} />
        </CardBody>
      </Card>

      {/* model config */}
      <Card>
        <CardHeader title="AI provider & model" />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <Field label="Provider">
            <Select value={agent.provider} onChange={(e) => save({ provider: e.target.value as AgentDetail["provider"] })}>
              <option value="ANTHROPIC">Claude (Anthropic)</option>
              <option value="OPENAI">OpenAI</option>
              <option value="GOOGLE">Google (Gemini)</option>
            </Select>
          </Field>
          <SaveOnBlurInput label="Model" value={agent.model} onSave={(v) => save({ model: v })} />
          <SaveOnBlurInput
            label="Temperature (0–2)"
            value={String(agent.temperature)}
            onSave={(v) => {
              const n = Number(v);
              if (Number.isFinite(n) && n >= 0 && n <= 2) void save({ temperature: n });
              else toast.error("Temperature must be between 0 and 2");
            }}
          />
          <SaveOnBlurInput
            label="Max tokens per reply"
            value={String(agent.maxTokens)}
            onSave={(v) => {
              const n = Math.round(Number(v));
              if (Number.isFinite(n) && n >= 64 && n <= 8192) void save({ maxTokens: n });
              else toast.error("Max tokens must be 64–8192");
            }}
          />
          <SaveOnBlurInput label="Language" value={agent.language ?? ""} onSave={(v) => save({ language: v || null })} />
          <SaveOnBlurInput label="Tone" value={agent.tone ?? ""} onSave={(v) => save({ tone: v || null })} />
          <SaveOnBlurInput
            label="Max replies per user per hour"
            value={String(agent.maxRepliesPerUserPerHour)}
            onSave={(v) => {
              const n = Math.round(Number(v));
              if (Number.isFinite(n) && n >= 1 && n <= 200) void save({ maxRepliesPerUserPerHour: n });
              else toast.error("Must be 1–200");
            }}
          />
          <Field label="Default lead flow" hint="Used by the start_lead_flow tool">
            <Select
              value={agent.defaultLeadFlowId ?? ""}
              onChange={(e) => save({ defaultLeadFlowId: e.target.value || null })}
            >
              <option value="">— none —</option>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {!f.enabled ? " (disabled)" : ""}
                </option>
              ))}
            </Select>
          </Field>
        </CardBody>
      </Card>

      {/* prompts */}
      <Card>
        <CardHeader
          title="Prompt & business knowledge"
          description="The AI may ONLY state facts from Business Context / Knowledge Base — hard anti-invention rules are always appended (prices, addresses, discounts, availability, policies)."
        />
        <CardBody className="space-y-4">
          <PromptEditor label="System Prompt" value={agent.systemPrompt} rows={5} onSave={(v) => save({ systemPrompt: v }, "Prompt updated (audit-logged)")} required />
          <PromptEditor label="Business Context — the only source of facts" value={agent.businessContext ?? ""} rows={6} onSave={(v) => save({ businessContext: v || null })} placeholder="Prices, addresses, schedules, policies…" />
          <PromptEditor label="Sales Strategy" value={agent.salesStrategy ?? ""} rows={3} onSave={(v) => save({ salesStrategy: v || null })} />
          <PromptEditor label="Conversation Rules" value={agent.conversationRules ?? ""} rows={3} onSave={(v) => save({ conversationRules: v || null })} />
          <PromptEditor label="Escalation Rules" value={agent.escalationRules ?? ""} rows={3} onSave={(v) => save({ escalationRules: v || null })} />
        </CardBody>
      </Card>

      {/* tool permissions (spec §34) */}
      <Card>
        <CardHeader
          title="Tool permissions"
          description="What the agent is allowed to DO. High-risk tools only ever create drafts for admin review — the AI can never publish content, launch campaigns, or spend budget."
        />
        <CardBody className="divide-y divide-[--color-border]">
          {tools.map((tool) => (
            <ToggleRow
              key={tool.id}
              label={`${tool.id} ${tool.risk === "HIGH_RISK" ? "⚠" : ""}`}
              description={`${tool.risk} · ${tool.description}`}
              danger={tool.risk === "HIGH_RISK"}
              checked={agent.allowedTools.includes(tool.id)}
              onCheckedChange={(v) => {
                const next = v ? [...agent.allowedTools, tool.id] : agent.allowedTools.filter((t) => t !== tool.id);
                void save({ allowedTools: next }, `Tool ${tool.id} ${v ? "enabled" : "disabled"}`);
              }}
            />
          ))}
        </CardBody>
      </Card>
      {busy && <p className="text-xs text-[--color-fg-faint]">Saving…</p>}
    </div>
  );
}

function SaveOnBlurInput({ label, value, onSave }: { label: string; value: string; onSave: (v: string) => void }) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);
  return (
    <Field label={label}>
      <Input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          if (local !== value) onSave(local);
        }}
      />
    </Field>
  );
}

function PromptEditor({
  label,
  value,
  rows,
  onSave,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  rows: number;
  onSave: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);
  const dirty = local !== value;
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium text-[--color-fg-muted]">{label}</span>
        <Button size="sm" variant={dirty ? "default" : "ghost"} disabled={!dirty || (required && !local.trim())} onClick={() => onSave(local)}>
          Save
        </Button>
      </div>
      <Textarea rows={rows} value={local} onChange={(e) => setLocal(e.target.value)} placeholder={placeholder} />
    </div>
  );
}
