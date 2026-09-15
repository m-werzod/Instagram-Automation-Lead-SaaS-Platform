"use client";

import * as React from "react";
import { toast } from "sonner";
import { Filter, Plus, Zap } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { timeAgo } from "@/lib/utils";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea, Segmented } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/page-header";
import type { Dictionary } from "@/lib/i18n/dictionaries";

/** Rules tab — WHEN trigger → optional condition → THEN action (spec §27). */

const TRIGGER_KEYS = [
  "MESSAGE_RECEIVED",
  "COMMENT_RECEIVED",
  "LEAD_SUBMITTED",
  "LEAD_STATUS_CHANGED",
  "CONVERSATION_HANDOFF",
] as const;

const ACTION_KEYS = [
  "SEND_MESSAGE",
  "SEND_PRIVATE_REPLY",
  "REPLY_COMMENT",
  "START_LEAD_FLOW",
  "SET_LEAD_STATUS",
  "NOTIFY_ADMIN",
  "SET_AI",
  "SEND_COMMENT_RESOURCE",
] as const;

const CONDITION_FIELDS = ["text", "source", "lead_status", "username"] as const;
const CONDITION_OPS = ["contains", "not_contains", "equals", "starts_with", "regex"] as const;
const LEAD_STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"] as const;

/** Localized trigger name; unknown keys fall back to the raw key. */
function triggerLabel(d: Dictionary, key: string): string {
  return (d.automation.rules.triggers as Record<string, string>)[key] ?? key;
}

/** Localized action name; runtime action types are UPPER_CASE, dictionary keys lower_case. */
function actionLabel(d: Dictionary, key: string): string {
  const map = d.automation.rules.actions as Record<string, string>;
  const alias = key === "NOTIFY_ADMIN" ? map.notify_email : undefined;
  return map[key] ?? map[key.toLowerCase()] ?? alias ?? key;
}

interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: string;
  contentId: string | null;
  content: { id: string; caption: string | null; mediaProductType: string | null; thumbnailUrl: string | null } | null;
  conditions: Array<{ field: string; op: string; value: string }>;
  actions: Array<{ type: string; params: Record<string, unknown> }>;
  runCount: number;
  lastRunAt: string | null;
  isDemo: boolean;
  _count: { runs: number };
}

export function RulesTab({ accountId }: { accountId: string }) {
  const { d } = useI18n();
  const [rows, setRows] = React.useState<AutomationRow[] | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [runsFor, setRunsFor] = React.useState<AutomationRow | null>(null);
  const [deleteFor, setDeleteFor] = React.useState<AutomationRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const data = await api<{ automations: AutomationRow[] }>(`/api/automations?accountId=${accountId}`, { silent: true });
    setRows(data.automations);
  }, [accountId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function toggle(a: AutomationRow, enabled: boolean) {
    setRows((prev) => prev?.map((r) => (r.id === a.id ? { ...r, enabled } : r)) ?? null);
    try {
      await api(`/api/automations/${a.id}`, { method: "PATCH", json: { enabled } });
      toast.success(`${a.name}: ${enabled ? d.common.enabled : d.common.disabled}`);
    } catch {
      await load();
    }
  }

  async function removeRule() {
    if (!deleteFor) return;
    setDeleteBusy(true);
    try {
      await api(`/api/automations/${deleteFor.id}`, { method: "DELETE" });
      setDeleteFor(null);
      await load();
    } finally {
      setDeleteBusy(false);
    }
  }

  if (rows === null) {
    return <p className="py-8 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>;
  }

  return (
    <div className="space-y-4">
      {rows.length === 0 ? (
        <EmptyState
          icon={
            <IconChip color="var(--color-mod-ai)" size={48}>
              <Zap size={22} />
            </IconChip>
          }
          title={d.automation.rules.empty}
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> {d.automation.rules.create}
            </Button>
          }
        />
      ) : (
        <>
          <div className="flex justify-end">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> {d.automation.rules.create}
            </Button>
          </div>

          {rows.map((a) => (
            <Card key={a.id}>
              <CardHeader
                icon={
                  <IconChip color="var(--color-mod-ai)">
                    <Zap size={16} />
                  </IconChip>
                }
                title={
                  <span className="flex items-center gap-2">
                    {a.name}
                    {a.isDemo && <Badge tone="warn">{d.shell.demo}</Badge>}
                  </span>
                }
                description={a.description ?? undefined}
                actions={
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] font-semibold ${a.enabled ? "text-(--color-on)" : "text-(--color-off)"}`}>
                      {a.enabled ? d.common.on : d.common.off}
                    </span>
                    <Switch checked={a.enabled} onCheckedChange={(v) => toggle(a, v)} />
                  </div>
                }
              />
              <CardBody className="space-y-2">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge tone="accent">
                    {d.automation.rules.when}: {triggerLabel(d, a.trigger)}
                  </Badge>
                  {a.trigger === "COMMENT_RECEIVED" && (
                    <Badge>
                      {a.content ? `${d.automation.rules.scopedTo}: ${a.content.caption?.slice(0, 30) || d.automation.rules.untitledPost}` : d.automation.rules.allPosts}
                    </Badge>
                  )}
                  {a.conditions.map((c, i) => (
                    <Badge key={i}>
                      {c.field} {c.op} &ldquo;{c.value}&rdquo;
                    </Badge>
                  ))}
                  {a.actions.map((act, i) => (
                    <Badge key={i} tone="ok">
                      {d.automation.rules.then}: {actionLabel(d, act.type)}
                    </Badge>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[11px] text-(--color-fg-faint)">
                  <span>{d.automation.rules.runs(a.runCount)}</span>
                  <span>{a.lastRunAt ? timeAgo(a.lastRunAt) : "—"}</span>
                  <Button size="sm" variant="ghost" onClick={() => setRunsFor(a)}>
                    {d.automation.rules.history}
                  </Button>
                  <Button size="sm" variant="ghost" className="hover:text-(--color-danger)" onClick={() => setDeleteFor(a)}>
                    {d.common.delete}
                  </Button>
                </div>
              </CardBody>
            </Card>
          ))}
        </>
      )}

      <CreateRuleDialog open={createOpen} onOpenChange={setCreateOpen} accountId={accountId} onCreated={load} />
      {runsFor && <RunsDialog automation={runsFor} onClose={() => setRunsFor(null)} />}

      <Dialog open={deleteFor !== null} onOpenChange={(v) => !v && setDeleteFor(null)}>
        {deleteFor && (
          <DialogContent title={d.common.delete}>
            <p className="text-sm text-(--color-fg-muted)">{d.common.confirmDelete(deleteFor.name)}</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDeleteFor(null)}>
                {d.common.cancel}
              </Button>
              <Button variant="danger" disabled={deleteBusy} onClick={removeRule}>
                {d.common.delete}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

function RunsDialog({ automation, onClose }: { automation: AutomationRow; onClose: () => void }) {
  const { d } = useI18n();
  const [runs, setRuns] = React.useState<
    Array<{ id: string; status: string; error: string | null; createdAt: string; durationMs: number | null }>
  >([]);

  React.useEffect(() => {
    api<{ automation: { runs: typeof runs } }>(`/api/automations/${automation.id}`, { silent: true })
      .then((data) => setRuns(data.automation.runs))
      .catch(() => undefined);
  }, [automation.id]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={`${d.automation.rules.history} — ${automation.name}`}>
        <div className="max-h-80 space-y-1 overflow-y-auto text-xs">
          {runs.length === 0 && <p className="text-(--color-fg-muted)">{d.common.none}</p>}
          {runs.map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-(--color-border) py-1.5 last:border-0">
              <Badge tone={r.status === "SUCCESS" ? "ok" : r.status === "SKIPPED" ? "warn" : "danger"}>{r.status}</Badge>
              <span className="mx-2 flex-1 truncate text-(--color-fg-muted)">{r.error ?? ""}</span>
              <span className="shrink-0 text-(--color-fg-faint)">
                {timeAgo(r.createdAt)} · {r.durationMs ?? 0}ms
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateRuleDialog({
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
  const { d } = useI18n();
  const [name, setName] = React.useState("");
  const [trigger, setTrigger] = React.useState<string>("MESSAGE_RECEIVED");
  const [condField, setCondField] = React.useState<string>("text");
  const [condOp, setCondOp] = React.useState<string>("contains");
  const [condValue, setCondValue] = React.useState("");
  const [actionType, setActionType] = React.useState<string>("NOTIFY_ADMIN");
  const [actionText, setActionText] = React.useState("");
  const [flowId, setFlowId] = React.useState("");
  const [flows, setFlows] = React.useState<Array<{ id: string; name: string }>>([]);
  const [leadStatus, setLeadStatus] = React.useState<string>("CONTACTED");
  const [contentId, setContentId] = React.useState(""); // "" = every post/reel on the account
  const [contentItems, setContentItems] = React.useState<Array<{ id: string; caption: string | null }>>([]);
  const [resourceMode, setResourceMode] = React.useState<"template" | "ai">("template");
  const [resourceId, setResourceId] = React.useState("");
  const [resourceAgentId, setResourceAgentId] = React.useState("");
  const [resources, setResources] = React.useState<Array<{ id: string; name: string }>>([]);
  const [agents, setAgents] = React.useState<Array<{ id: string; name: string }>>([]);
  const [cooldown, setCooldown] = React.useState<"" | "3600" | "86400" | "604800" | "custom">("");
  const [cooldownCustomMin, setCooldownCustomMin] = React.useState("60");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    api<{ flows: Array<{ id: string; name: string }> }>(`/api/lead-flows?accountId=${accountId}`, { silent: true })
      .then((data) => {
        setFlows(data.flows);
        if (data.flows[0]) setFlowId(data.flows[0].id);
      })
      .catch(() => undefined);
    api<{ items: Array<{ id: string; caption: string | null }> }>(`/api/content?accountId=${accountId}`, { silent: true })
      .then((data) => setContentItems(data.items))
      .catch(() => undefined);
    api<{ resources: Array<{ id: string; name: string }> }>(`/api/comment-resources?accountId=${accountId}`, { silent: true })
      .then((data) => setResources(data.resources))
      .catch(() => undefined);
    api<{ agents: Array<{ id: string; name: string }> }>(`/api/agents?accountId=${accountId}`, { silent: true })
      .then((data) => setAgents(data.agents))
      .catch(() => undefined);
  }, [open, accountId]);

  const isResourceAction = actionType === "SEND_COMMENT_RESOURCE";
  const needsText = ["SEND_MESSAGE", "SEND_PRIVATE_REPLY", "REPLY_COMMENT", "NOTIFY_ADMIN"].includes(actionType) || isResourceAction;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const action =
      actionType === "START_LEAD_FLOW"
        ? { type: actionType, params: { flowId } }
        : actionType === "SET_LEAD_STATUS"
          ? { type: actionType, params: { status: leadStatus } }
          : actionType === "SET_AI"
            ? { type: actionType, params: { enabled: false } }
            : isResourceAction
              ? {
                  type: actionType,
                  params: {
                    mode: resourceMode,
                    text: actionText,
                    resourceId: resourceId || undefined,
                    agentId: resourceMode === "ai" ? resourceAgentId : undefined,
                  },
                }
              : { type: actionType, params: { text: actionText } };
    const cooldownSec = cooldown === "" ? null : cooldown === "custom" ? Math.max(60, Number(cooldownCustomMin) * 60) : Number(cooldown);
    setBusy(true);
    try {
      await api("/api/automations", {
        method: "POST",
        json: {
          accountId,
          name,
          trigger,
          contentId: trigger === "COMMENT_RECEIVED" && contentId ? contentId : null,
          conditions: condValue ? [{ field: condField, op: condOp, value: condValue }] : [],
          actions: [action],
          enabled: false,
          cooldownSec,
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
      <DialogContent wide title={d.automation.rules.create}>
        <form onSubmit={submit} className="space-y-3">
          <Field label={d.common.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
          </Field>
          <Field label={d.automation.rules.when}>
            <Select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              {TRIGGER_KEYS.map((t) => (
                <option key={t} value={t}>
                  {triggerLabel(d, t)}
                </option>
              ))}
            </Select>
          </Field>

          {trigger === "COMMENT_RECEIVED" && (
            <Field label={d.automation.rules.scope} hint={d.automation.rules.scopeHint}>
              <Select value={contentId} onChange={(e) => setContentId(e.target.value)}>
                <option value="">{d.automation.rules.allPosts}</option>
                {contentItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.caption?.slice(0, 60) || d.automation.rules.untitledPost}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {/* optional condition — raw field/operator identifiers, empty value = always */}
          <div>
            <div className="mb-1.5 flex items-center gap-1 text-xs font-medium text-(--color-fg-muted)">
              <Filter size={13} aria-hidden />
              <span>({d.common.optional.toLowerCase()})</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Select aria-label="field" value={condField} onChange={(e) => setCondField(e.target.value)}>
                {CONDITION_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </Select>
              <Select aria-label="operator" value={condOp} onChange={(e) => setCondOp(e.target.value)}>
                {CONDITION_OPS.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
              <Input aria-label="value" value={condValue} onChange={(e) => setCondValue(e.target.value)} />
            </div>
          </div>

          <Field label={d.automation.rules.then}>
            <Select value={actionType} onChange={(e) => setActionType(e.target.value)}>
              {ACTION_KEYS.map((a) => (
                <option key={a} value={a}>
                  {actionLabel(d, a)}
                </option>
              ))}
            </Select>
          </Field>

          {isResourceAction && (
            <Segmented
              value={resourceMode}
              onChange={(v) => setResourceMode(v as "template" | "ai")}
              options={[
                { value: "template", label: d.automation.rules.modeTemplate },
                { value: "ai", label: d.automation.rules.modeAi },
              ]}
            />
          )}
          {needsText && (
            <Textarea
              rows={2}
              aria-label={d.automation.rules.then}
              placeholder={isResourceAction && resourceMode === "ai" ? d.automation.rules.aiInstructionPh : d.conversations.composerPh}
              value={actionText}
              onChange={(e) => setActionText(e.target.value)}
              required
            />
          )}
          {isResourceAction && (
            <>
              <Field label={d.automation.rules.resource} hint={d.automation.rules.resourceHint}>
                <Select value={resourceId} onChange={(e) => setResourceId(e.target.value)}>
                  <option value="">{d.common.none}</option>
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {resourceMode === "ai" && (
                <Field label={d.automation.rules.composingAgent}>
                  <Select value={resourceAgentId} onChange={(e) => setResourceAgentId(e.target.value)} required>
                    <option value="" disabled>
                      {d.common.select}
                    </option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
            </>
          )}
          {actionType === "START_LEAD_FLOW" && (
            <Field label={actionLabel(d, "START_LEAD_FLOW")}>
              <Select value={flowId} onChange={(e) => setFlowId(e.target.value)}>
                {flows.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {actionType === "SET_LEAD_STATUS" && (
            <Field label={actionLabel(d, "SET_LEAD_STATUS")}>
              <Select value={leadStatus} onChange={(e) => setLeadStatus(e.target.value)}>
                {LEAD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {d.leads.statuses[s]}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label={d.automation.rules.cooldown.label} hint={d.automation.rules.cooldown.hint}>
            <Select value={cooldown} onChange={(e) => setCooldown(e.target.value as typeof cooldown)}>
              <option value="">{d.automation.rules.cooldown.none}</option>
              <option value="3600">{d.automation.rules.cooldown.hour1}</option>
              <option value="86400">{d.automation.rules.cooldown.hours24}</option>
              <option value="604800">{d.automation.rules.cooldown.days7}</option>
              <option value="custom">{d.automation.rules.cooldown.custom}</option>
            </Select>
          </Field>
          {cooldown === "custom" && (
            <Field label={d.automation.rules.cooldown.customMinutes}>
              <Input
                type="number"
                min={1}
                value={cooldownCustomMin}
                onChange={(e) => setCooldownCustomMin(e.target.value)}
              />
            </Field>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {d.common.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? d.common.saving : d.automation.rules.create}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
