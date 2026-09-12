"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Bot,
  Clock,
  FlaskConical,
  Hash,
  MessageSquareText,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Smile,
  Thermometer,
  Trash2,
  Wrench,
} from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleRow } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { cn, formatDate } from "@/lib/utils";

/**
 * Agent settings (spec §8, §10, §34). Every toggle maps to a real runtime
 * guard in src/lib/agent/runtime.ts — none of them is decorative. The test
 * console at the bottom runs the same pipeline the worker runs, minus the
 * Instagram send and minus real side effects.
 */

type Provider = "ANTHROPIC" | "OPENAI" | "GOOGLE";
type ResponseLength = "SHORT" | "MEDIUM" | "LONG";

interface WorkingHours {
  timezone: string;
  days: number[];
  start: string;
  end: string;
}

interface AgentDetail {
  id: string;
  accountId: string;
  name: string;
  description: string | null;
  enabled: boolean;
  provider: Provider;
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
  workingHours: WorkingHours | null;
  outsideHoursReply: string | null;
  fallbackReply: string | null;
  allowedTopics: string | null;
  prohibitedTopics: string | null;
  responseLength: ResponseLength;
  ctaText: string | null;
  faq: string | null;
  account: { id: string; username: string };
}

interface ToolInfo {
  id: string;
  risk: "READ" | "WRITE" | "HIGH_RISK";
  description: string;
}

interface Usage {
  days: number;
  calls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgLatencyMs: number | null;
}

interface RecentError {
  error: string | null;
  createdAt: string;
  purpose: string;
  model: string;
}

interface Runtime {
  provider: string;
  configured: boolean;
  model: string;
  host: string | null;
}

interface AgentResponse {
  agent: AgentDetail;
  flows: Array<{ id: string; name: string; enabled: boolean }>;
  providerConfigured: boolean;
  runtime: Runtime;
  usage: Usage;
  recentErrors: RecentError[];
}

export default function AgentSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { d } = useI18n();
  const t = d.automation.agents;
  const [data, setData] = React.useState<AgentResponse | null>(null);
  const [tools, setTools] = React.useState<ToolInfo[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    const res = await api<AgentResponse>(`/api/agents/${id}`, { silent: true });
    setData(res);
    const list = await api<{ availableTools: ToolInfo[] }>(`/api/agents?accountId=${res.agent.accountId}`, { silent: true });
    setTools(list.availableTools);
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const agent = data?.agent ?? null;

  async function save(patch: Partial<AgentDetail>, message?: string) {
    if (!agent) return;
    setBusy(true);
    try {
      const res = await api<{ agent: AgentDetail }>(`/api/agents/${agent.id}`, { method: "PATCH", json: patch });
      setData((prev) => (prev ? { ...prev, agent: { ...prev.agent, ...res.agent } } : prev));
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

  if (!agent || !data) {
    return <p className="py-20 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>;
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
            <p className="text-xs text-(--color-fg-muted)">
              @{agent.account.username} · {agent.model}
            </p>
          </div>
        </div>
      </div>

      {!data.providerConfigured && (
        <div className="flex items-start gap-2 rounded-xl border border-(--color-danger)/30 bg-(--color-danger-soft) px-4 py-3 text-xs leading-5 text-(--color-danger)">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          {t.notConfigured}
        </div>
      )}

      {/* master switch — the agent does nothing while OFF */}
      <Card className={agent.enabled ? "border-(--color-ok)/40" : undefined}>
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

      {/* test console — rehearse before switching on */}
      <TestConsole agentId={agent.id} configured={data.providerConfigured} />

      {/* behavior toggles — each enforced in the reply pipeline */}
      <Card>
        <CardHeader icon={<IconChip color="var(--color-mod-ai)"><SlidersHorizontal size={16} /></IconChip>} title={t.behavior} />
        <CardBody className="divide-y divide-(--color-border)">
          <ToggleRow label={t.autoReply} checked={agent.autoReply} onCheckedChange={(v) => save({ autoReply: v })} onLabel={d.common.on} offLabel={d.common.off} />
          <ToggleRow label={t.leadQualification} checked={agent.leadQualification} onCheckedChange={(v) => save({ leadQualification: v })} onLabel={d.common.on} offLabel={d.common.off} />
          <ToggleRow label={t.knowledgeEnabled} checked={agent.knowledgeEnabled} onCheckedChange={(v) => save({ knowledgeEnabled: v })} onLabel={d.common.on} offLabel={d.common.off} />
          <ToggleRow label={t.humanHandoff} checked={agent.humanHandoffEnabled} onCheckedChange={(v) => save({ humanHandoffEnabled: v })} onLabel={d.common.on} offLabel={d.common.off} />
          <ToggleRow label={t.commentReply} checked={agent.commentReplyEnabled} onCheckedChange={(v) => save({ commentReplyEnabled: v })} onLabel={d.common.on} offLabel={d.common.off} />
        </CardBody>
      </Card>

      {/* model & limits */}
      <Card>
        <CardHeader
          icon={<IconChip color="var(--color-mod-ai)"><Bot size={16} /></IconChip>}
          title={t.model}
          description={data.runtime.host ? t.runtimeHint(data.runtime.host, data.runtime.model) : undefined}
        />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <Field label={t.providerLabel}>
            <Select value={agent.provider} onChange={(e) => save({ provider: e.target.value as Provider })}>
              {(["ANTHROPIC", "OPENAI", "GOOGLE"] as const).map((p) => (
                <option key={p} value={p}>
                  {t.providers[p]}
                </option>
              ))}
            </Select>
          </Field>
          <SaveOnBlurInput label={t.model} ariaLabel={t.model} value={agent.model} onSave={(v) => save({ model: v })} />
          <SaveOnBlurInput
            label={<span className="inline-flex items-center gap-1"><Thermometer size={13} aria-hidden /> 0–2</span>}
            ariaLabel="temperature"
            value={String(agent.temperature)}
            onSave={(v) => {
              const n = Number(v);
              if (Number.isFinite(n) && n >= 0 && n <= 2) void save({ temperature: n });
              else toast.error(d.landing.invalidValue);
            }}
          />
          <SaveOnBlurInput
            label={<span className="inline-flex items-center gap-1"><Hash size={13} aria-hidden /> 64–8192</span>}
            ariaLabel="max tokens"
            value={String(agent.maxTokens)}
            onSave={(v) => {
              const n = Math.round(Number(v));
              if (Number.isFinite(n) && n >= 64 && n <= 8192) void save({ maxTokens: n });
              else toast.error(d.landing.invalidValue);
            }}
          />
          <Field label={t.responseLength}>
            <Select value={agent.responseLength} onChange={(e) => save({ responseLength: e.target.value as ResponseLength })}>
              {(["SHORT", "MEDIUM", "LONG"] as const).map((l) => (
                <option key={l} value={l}>
                  {t.lengths[l]}
                </option>
              ))}
            </Select>
          </Field>
          <SaveOnBlurInput label={t.language} ariaLabel={t.language} value={agent.language ?? ""} onSave={(v) => save({ language: v || null })} />
          <SaveOnBlurInput
            label={<span className="inline-flex items-center gap-1"><Smile size={13} aria-hidden /></span>}
            ariaLabel="tone"
            value={agent.tone ?? ""}
            onSave={(v) => save({ tone: v || null })}
          />
          <SaveOnBlurInput
            label={t.maxPerHour}
            ariaLabel={t.maxPerHour}
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
              {data.flows.map((f) => (
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
        <CardHeader icon={<IconChip color="var(--color-mod-ai)"><MessageSquareText size={16} /></IconChip>} title={t.prompts} />
        <CardBody className="space-y-4">
          <PromptEditor label={t.systemPrompt} value={agent.systemPrompt} rows={5} required onSave={(v) => save({ systemPrompt: v })} />
          <PromptEditor label={t.businessContext} hint={t.businessContextHint} value={agent.businessContext ?? ""} rows={6} onSave={(v) => save({ businessContext: v || null })} />
          <PromptEditor label={t.faq} value={agent.faq ?? ""} rows={5} onSave={(v) => save({ faq: v || null })} />
          <PromptEditor label={t.salesStrategy} value={agent.salesStrategy ?? ""} rows={3} onSave={(v) => save({ salesStrategy: v || null })} />
          <SaveOnBlurInput label={t.ctaText} ariaLabel={t.ctaText} value={agent.ctaText ?? ""} placeholder={t.ctaTextPh} onSave={(v) => save({ ctaText: v || null })} />
          <PromptEditor label={t.conversationRules} value={agent.conversationRules ?? ""} rows={3} onSave={(v) => save({ conversationRules: v || null })} />
          <PromptEditor label={t.escalationRules} value={agent.escalationRules ?? ""} rows={3} onSave={(v) => save({ escalationRules: v || null })} />
        </CardBody>
      </Card>

      {/* availability + safety — enforced by src/lib/agent/guardrails.ts */}
      <Card>
        <CardHeader icon={<IconChip color="var(--color-mod-ai)"><ShieldCheck size={16} /></IconChip>} title={t.safety} description={t.safetyHint} />
        <CardBody className="space-y-4">
          <WorkingHoursEditor value={agent.workingHours} onSave={(v) => save({ workingHours: v })} />
          <PromptEditor label={t.outsideHoursReply} value={agent.outsideHoursReply ?? ""} rows={2} onSave={(v) => save({ outsideHoursReply: v || null })} />
          <PromptEditor label={t.fallbackReply} value={agent.fallbackReply ?? ""} rows={2} onSave={(v) => save({ fallbackReply: v || null })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <PromptEditor label={t.allowedTopics} value={agent.allowedTopics ?? ""} rows={2} onSave={(v) => save({ allowedTopics: v || null })} />
            <PromptEditor label={t.prohibitedTopics} value={agent.prohibitedTopics ?? ""} rows={2} onSave={(v) => save({ prohibitedTopics: v || null })} />
          </div>
        </CardBody>
      </Card>

      {/* tool permissions (spec §34) — tool ids and risk levels are technical identifiers */}
      <Card>
        <CardHeader icon={<IconChip color="var(--color-mod-ai)"><Wrench size={16} /></IconChip>} title={d.common.actions} />
        <CardBody className="divide-y divide-(--color-border)">
          {tools.map((tool) => (
            <ToggleRow
              key={tool.id}
              label={tool.id}
              description={`${tool.risk} · ${tool.description}`}
              danger={tool.risk === "HIGH_RISK"}
              checked={agent.allowedTools.includes(tool.id)}
              onCheckedChange={(v) => {
                const next = v ? [...agent.allowedTools, tool.id] : agent.allowedTools.filter((x) => x !== tool.id);
                void save({ allowedTools: next });
              }}
              onLabel={d.common.on}
              offLabel={d.common.off}
            />
          ))}
        </CardBody>
      </Card>

      {/* usage — real numbers from AIUsage */}
      <Card>
        <CardHeader icon={<IconChip color="var(--color-mod-ai)"><Activity size={16} /></IconChip>} title={t.usage.title} />
        <CardBody className="space-y-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Stat label={t.usage.calls} value={String(data.usage.calls)} />
            <Stat label={t.usage.failures} value={String(data.usage.failures)} tone={data.usage.failures > 0 ? "danger" : undefined} />
            <Stat label={t.usage.tokens} value={`${(data.usage.inputTokens + data.usage.outputTokens).toLocaleString()}`} />
            <Stat label={t.usage.cost} value={`$${data.usage.costUsd.toFixed(4)}`} />
            <Stat label={t.usage.latency} value={data.usage.avgLatencyMs ? `${(data.usage.avgLatencyMs / 1000).toFixed(1)}s` : "—"} />
          </div>
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-(--color-fg-faint)">{t.usage.recentErrors}</div>
            {data.recentErrors.length === 0 ? (
              <p className="text-xs text-(--color-fg-muted)">{t.usage.none}</p>
            ) : (
              <ul className="space-y-1">
                {data.recentErrors.map((e, i) => (
                  <li key={i} className="rounded-md bg-(--color-danger-soft) px-2 py-1.5 text-[11px] leading-4 text-(--color-danger)">
                    <span className="text-(--color-fg-faint)">{formatDate(e.createdAt)} · {e.purpose} · {e.model} — </span>
                    {e.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </CardBody>
      </Card>

      {/* danger zone */}
      <Card className="border-(--color-danger)/40">
        <CardHeader title={t.dangerZone} />
        <CardBody className="flex justify-end">
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>
            <Trash2 size={14} /> {t.deleteAgent}
          </Button>
        </CardBody>
      </Card>

      {busy && <p className="text-xs text-(--color-fg-faint)">{d.common.saving}</p>}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent title={t.deleteAgent}>
          <p className="text-sm text-(--color-fg-muted)">{d.common.confirmDelete(agent.name)}</p>
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

/* ---------- test console ---------- */

interface TurnResult {
  text: string | null;
  guard: { action: "replied" | "fallback" | "blocked" | "outside_hours" | "no_text"; reason?: string };
  toolTrace: Array<{ name: string; arguments: Record<string, unknown>; output: string }>;
  effects: { suppressReply: boolean; handedOff: boolean; flowMessages: Array<{ text: string }> | null };
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  model: string;
}

interface ChatItem {
  role: "user" | "assistant";
  text: string;
  meta?: TurnResult;
}

function TestConsole({ agentId, configured }: { agentId: string; configured: boolean }) {
  const { d } = useI18n();
  const t = d.automation.agents.test;
  const [items, setItems] = React.useState<ChatItem[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    const history = items.filter((i) => i.text).map((i) => ({ role: i.role, text: i.text }));
    setItems((prev) => [...prev, { role: "user", text: message }]);
    setInput("");
    setBusy(true);
    try {
      const { result } = await api<{ result: TurnResult }>(`/api/agents/${agentId}/test`, {
        method: "POST",
        json: { message, history },
      });
      const shown =
        result.text ??
        result.effects.flowMessages?.map((m) => m.text).join("\n") ??
        "";
      setItems((prev) => [...prev, { role: "assistant", text: shown, meta: result }]);
    } catch {
      // the toast from api() already explains; keep the user's message so they can retry
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-(--color-mod-ai)/30">
      <CardHeader
        icon={<IconChip color="var(--color-mod-ai)"><FlaskConical size={16} /></IconChip>}
        title={t.title}
        description={t.subtitle}
        actions={
          items.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => setItems([])}>
              {t.clear}
            </Button>
          ) : undefined
        }
      />
      <CardBody className="space-y-3">
        <div className="max-h-96 space-y-2 overflow-y-auto rounded-lg bg-(--color-panel-2) p-3">
          {items.length === 0 && <p className="py-6 text-center text-xs text-(--color-fg-muted)">{t.empty}</p>}
          {items.map((item, i) => (
            <div key={i} className={cn("flex", item.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[85%] space-y-1", item.role === "user" ? "items-end" : "items-start")}>
                <div
                  className={cn(
                    "rounded-2xl px-3 py-2 text-[13px] leading-5 whitespace-pre-wrap",
                    item.role === "user" ? "bg-(--color-accent) text-white" : "bg-(--color-panel) border border-(--color-border)",
                  )}
                >
                  {item.text || <span className="italic text-(--color-fg-faint)">({t.guard.no_text})</span>}
                </div>
                {item.meta && <TurnMeta meta={item.meta} />}
              </div>
            </div>
          ))}
          {busy && <p className="text-xs text-(--color-fg-faint)">{d.common.loading}</p>}
          <div ref={endRef} />
        </div>
        <form onSubmit={send} className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t.placeholder}
            disabled={busy || !configured}
            maxLength={900}
          />
          <Button type="submit" disabled={busy || !configured || !input.trim()}>
            <Send size={14} /> {t.send}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function TurnMeta({ meta }: { meta: TurnResult }) {
  const { d } = useI18n();
  const t = d.automation.agents.test;
  const tone = meta.guard.action === "replied" ? "ok" : meta.guard.action === "fallback" ? "warn" : "danger";
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px] text-(--color-fg-faint)">
      <Badge tone={tone}>{t.guard[meta.guard.action]}</Badge>
      {meta.guard.reason && <span className="text-(--color-warn)">{meta.guard.reason}</span>}
      {meta.effects.handedOff && <Badge tone="warn">handoff</Badge>}
      <span>
        {meta.inputTokens + meta.outputTokens} {t.tokens} · {(meta.latencyMs / 1000).toFixed(1)}s
        {meta.costUsd !== null ? ` · $${meta.costUsd.toFixed(5)}` : ""} · {meta.model}
      </span>
      {meta.toolTrace.length > 0 && (
        <details className="w-full">
          <summary className="cursor-pointer text-(--color-mod-ai)">
            {t.toolsUsed}: {meta.toolTrace.map((x) => x.name).join(", ")}
          </summary>
          <ul className="mt-1 space-y-1">
            {meta.toolTrace.map((x, i) => (
              <li key={i} className="rounded bg-(--color-panel) p-1.5 font-mono text-[10px] leading-4">
                <div className="font-semibold">
                  {x.name}({JSON.stringify(x.arguments)})
                </div>
                <div className="whitespace-pre-wrap text-(--color-fg-muted)">{x.output}</div>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/* ---------- working hours ---------- */

const COMMON_ZONES = ["Asia/Tashkent", "Asia/Almaty", "Europe/Moscow", "Europe/Istanbul", "Asia/Dubai", "Europe/London", "Europe/Berlin", "America/New_York", "UTC"];

function WorkingHoursEditor({ value, onSave }: { value: WorkingHours | null; onSave: (v: WorkingHours | null) => void }) {
  const { d } = useI18n();
  const t = d.automation.agents;
  const enabled = value !== null;
  const draft = value ?? { timezone: "Asia/Tashkent", days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "18:00" };

  function update(patch: Partial<WorkingHours>) {
    onSave({ ...draft, ...patch });
  }

  return (
    <div className="space-y-3">
      <ToggleRow
        label={t.workingHours}
        description={enabled ? `${draft.timezone} · ${draft.start}–${draft.end}` : t.alwaysOn}
        checked={enabled}
        onCheckedChange={(v) => onSave(v ? draft : null)}
        onLabel={d.common.on}
        offLabel={d.common.off}
      />
      {enabled && (
        <div className="grid gap-3 rounded-lg border border-(--color-border) p-3 sm:grid-cols-3">
          <Field label={t.timezone}>
            <Select value={draft.timezone} onChange={(e) => update({ timezone: e.target.value })}>
              {[...new Set([draft.timezone, ...COMMON_ZONES])].map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t.from}>
            <Input type="time" value={draft.start} onChange={(e) => e.target.value && update({ start: e.target.value })} />
          </Field>
          <Field label={t.to}>
            <Input type="time" value={draft.end} onChange={(e) => e.target.value && update({ end: e.target.value })} />
          </Field>
          <Field label={t.days} className="sm:col-span-3">
            <div className="flex flex-wrap gap-1.5">
              {t.dayNames.map((name, dayIdx) => {
                const on = draft.days.includes(dayIdx);
                return (
                  <button
                    key={dayIdx}
                    type="button"
                    onClick={() => {
                      const next = on ? draft.days.filter((x) => x !== dayIdx) : [...draft.days, dayIdx].sort();
                      if (next.length > 0) update({ days: next });
                    }}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs font-medium",
                      on ? "border-(--color-accent) bg-(--color-accent-soft) text-(--color-accent)" : "border-(--color-border) text-(--color-fg-muted)",
                    )}
                  >
                    <Clock size={10} className="mr-1 inline" aria-hidden />
                    {name}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>
      )}
    </div>
  );
}

/* ---------- small pieces ---------- */

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="rounded-lg bg-(--color-panel-2) px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-(--color-fg-faint)">{label}</div>
      <div className={cn("text-base font-bold tabular-nums", tone === "danger" && "text-(--color-danger)")}>{value}</div>
    </div>
  );
}

function SaveOnBlurInput({
  label,
  ariaLabel,
  value,
  placeholder,
  onSave,
}: {
  label: React.ReactNode;
  ariaLabel: string;
  value: string;
  placeholder?: string;
  onSave: (v: string) => void;
}) {
  const [local, setLocal] = React.useState(value);
  React.useEffect(() => setLocal(value), [value]);
  return (
    <div>
      <div className="mb-1.5 block text-xs font-medium text-(--color-fg-muted)">{label}</div>
      <Input
        aria-label={ariaLabel}
        value={local}
        placeholder={placeholder}
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
        <span className="text-xs font-medium text-(--color-fg-muted)">{label}</span>
        <Button size="sm" variant={dirty ? "default" : "ghost"} disabled={!dirty || (required && !local.trim())} onClick={() => onSave(local)}>
          {d.common.save}
        </Button>
      </div>
      {hint && <p className="mb-1.5 text-[11px] leading-4 text-(--color-fg-faint)">{hint}</p>}
      <Textarea rows={rows} value={local} onChange={(e) => setLocal(e.target.value)} />
    </div>
  );
}
