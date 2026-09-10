"use client";

import * as React from "react";
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
import { timeAgo } from "@/lib/utils";

/** Automation rules: TRIGGER → CONDITION → ACTION (spec §27). */

const TRIGGERS = [
  { value: "MESSAGE_RECEIVED", label: "New Instagram message" },
  { value: "COMMENT_RECEIVED", label: "New comment" },
  { value: "LEAD_SUBMITTED", label: "New lead submitted" },
  { value: "LEAD_STATUS_CHANGED", label: "Lead status changed" },
  { value: "CONVERSATION_HANDOFF", label: "Conversation handed to human" },
] as const;

interface AutomationRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: string;
  conditions: Array<{ field: string; op: string; value: string }>;
  actions: Array<{ type: string; params: Record<string, unknown> }>;
  runCount: number;
  lastRunAt: string | null;
  isDemo: boolean;
  _count: { runs: number };
}

export default function AutomationsPage() {
  const { selected } = useAccounts();
  const [rows, setRows] = React.useState<AutomationRow[] | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [runsFor, setRunsFor] = React.useState<AutomationRow | null>(null);

  const load = React.useCallback(async () => {
    if (!selected) return;
    const data = await api<{ automations: AutomationRow[] }>(`/api/automations?accountId=${selected.id}`, { silent: true });
    setRows(data.automations);
  }, [selected]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function toggle(a: AutomationRow, enabled: boolean) {
    setRows((prev) => prev?.map((r) => (r.id === a.id ? { ...r, enabled } : r)) ?? null);
    try {
      await api(`/api/automations/${a.id}`, { method: "PATCH", json: { enabled } });
      toast.success(`Automation ${enabled ? "enabled" : "disabled"} (audit-logged)`);
    } catch {
      await load();
    }
  }

  if (!selected) return <p className="text-sm text-[--color-fg-muted]">Connect an Instagram account first.</p>;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Automations"
        description="Simple rules: when something happens (a message, a comment, a new lead), optionally check a condition, then do something. Anything that sends a message respects the master switch and Instagram's 24-hour reply window."
        accent="var(--color-mod-ai)"
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={15} /> New automation
          </Button>
        }
      />

      {rows?.length === 0 && (
        <EmptyState
          title="No automations yet"
          description="For example: when a comment contains “price”, send that person a direct message with your lead form."
          action={<Button onClick={() => setCreateOpen(true)}>Create a rule</Button>}
        />
      )}

      {rows?.map((a) => (
        <Card key={a.id}>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                {a.name}
                {a.isDemo && <Badge tone="warn">DEMO</Badge>}
              </span>
            }
            description={a.description ?? undefined}
            actions={
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-semibold ${a.enabled ? "text-[--color-on]" : "text-[--color-off]"}`}>
                  {a.enabled ? "ON" : "OFF"}
                </span>
                <Switch checked={a.enabled} onCheckedChange={(v) => toggle(a, v)} />
              </div>
            }
          />
          <CardBody className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <Badge tone="accent">WHEN {TRIGGERS.find((t) => t.value === a.trigger)?.label ?? a.trigger}</Badge>
              {a.conditions.map((c, i) => (
                <Badge key={i}>
                  IF {c.field} {c.op} &ldquo;{c.value}&rdquo;
                </Badge>
              ))}
              {a.actions.map((act, i) => (
                <Badge key={i} tone="ok">
                  THEN {act.type}
                </Badge>
              ))}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-[--color-fg-faint]">
              <span>{a.runCount} runs</span>
              <span>last: {a.lastRunAt ? timeAgo(a.lastRunAt) : "never"}</span>
              <Button size="sm" variant="ghost" onClick={() => setRunsFor(a)}>
                View runs
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!confirm(`Delete automation "${a.name}"?`)) return;
                  await api(`/api/automations/${a.id}`, { method: "DELETE" });
                  await load();
                }}
              >
                Delete
              </Button>
            </div>
          </CardBody>
        </Card>
      ))}

      <CreateAutomationDialog open={createOpen} onOpenChange={setCreateOpen} accountId={selected.id} onCreated={load} />
      {runsFor && <RunsDialog automation={runsFor} onClose={() => setRunsFor(null)} />}
    </div>
  );
}

function RunsDialog({ automation, onClose }: { automation: AutomationRow; onClose: () => void }) {
  const [runs, setRuns] = React.useState<Array<{ id: string; status: string; error: string | null; createdAt: string; durationMs: number | null }>>([]);
  React.useEffect(() => {
    api<{ automation: { runs: typeof runs } }>(`/api/automations/${automation.id}`, { silent: true })
      .then((d) => setRuns(d.automation.runs))
      .catch(() => undefined);
  }, [automation.id]);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={`Runs — ${automation.name}`}>
        <div className="max-h-80 space-y-1 overflow-y-auto text-xs">
          {runs.length === 0 && <p className="text-[--color-fg-muted]">No runs recorded yet.</p>}
          {runs.map((r) => (
            <div key={r.id} className="flex items-center justify-between border-b border-[--color-border] py-1.5">
              <Badge tone={r.status === "SUCCESS" ? "ok" : "danger"}>{r.status}</Badge>
              <span className="mx-2 flex-1 truncate text-[--color-fg-muted]">{r.error ?? ""}</span>
              <span className="text-[--color-fg-faint]">
                {timeAgo(r.createdAt)} · {r.durationMs ?? 0}ms
              </span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateAutomationDialog({
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
  const [name, setName] = React.useState("");
  const [trigger, setTrigger] = React.useState<string>("MESSAGE_RECEIVED");
  const [condField, setCondField] = React.useState("text");
  const [condOp, setCondOp] = React.useState("contains");
  const [condValue, setCondValue] = React.useState("");
  const [actionType, setActionType] = React.useState("NOTIFY_ADMIN");
  const [actionText, setActionText] = React.useState("");
  const [flowId, setFlowId] = React.useState("");
  const [flows, setFlows] = React.useState<Array<{ id: string; name: string }>>([]);
  const [leadStatus, setLeadStatus] = React.useState("CONTACTED");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    api<{ flows: Array<{ id: string; name: string }> }>(`/api/lead-flows?accountId=${accountId}`, { silent: true })
      .then((d) => {
        setFlows(d.flows);
        if (d.flows[0]) setFlowId(d.flows[0].id);
      })
      .catch(() => undefined);
  }, [open, accountId]);

  const needsText = ["SEND_MESSAGE", "SEND_PRIVATE_REPLY", "REPLY_COMMENT", "NOTIFY_ADMIN"].includes(actionType);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const action =
      actionType === "START_LEAD_FLOW"
        ? { type: actionType, params: { flowId } }
        : actionType === "SET_LEAD_STATUS"
          ? { type: actionType, params: { status: leadStatus } }
          : actionType === "SET_AI"
            ? { type: actionType, params: { enabled: false } }
            : { type: actionType, params: { text: actionText } };
    setBusy(true);
    try {
      await api("/api/automations", {
        method: "POST",
        json: {
          accountId,
          name,
          trigger,
          conditions: condValue ? [{ field: condField, op: condOp, value: condValue }] : [],
          actions: [action],
          enabled: false,
        },
      });
      toast.success("Automation created (OFF by default)");
      onOpenChange(false);
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide title="New automation" description="Trigger → optional condition → action. Starts OFF.">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Pricing question → notify admin" />
          </Field>
          <Field label="Trigger">
            <Select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
              {TRIGGERS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Condition field">
              <Select value={condField} onChange={(e) => setCondField(e.target.value)}>
                <option value="text">text</option>
                <option value="source">source</option>
                <option value="lead_status">lead_status</option>
                <option value="username">username</option>
              </Select>
            </Field>
            <Field label="Operator">
              <Select value={condOp} onChange={(e) => setCondOp(e.target.value)}>
                <option value="contains">contains</option>
                <option value="not_contains">not_contains</option>
                <option value="equals">equals</option>
                <option value="starts_with">starts_with</option>
                <option value="regex">regex</option>
              </Select>
            </Field>
            <Field label="Value (empty = always)">
              <Input value={condValue} onChange={(e) => setCondValue(e.target.value)} placeholder="price" />
            </Field>
          </div>
          <Field label="Action">
            <Select value={actionType} onChange={(e) => setActionType(e.target.value)}>
              <option value="SEND_MESSAGE">Send DM reply (needs open 24h window)</option>
              <option value="SEND_PRIVATE_REPLY">Private reply to comment (DM)</option>
              <option value="REPLY_COMMENT">Public reply to comment</option>
              <option value="START_LEAD_FLOW">Start lead flow</option>
              <option value="SET_LEAD_STATUS">Set lead status</option>
              <option value="NOTIFY_ADMIN">Email admins</option>
              <option value="SET_AI">Disable AI for the conversation</option>
            </Select>
          </Field>
          {needsText && (
            <Field label="Message / text">
              <Textarea rows={2} value={actionText} onChange={(e) => setActionText(e.target.value)} required />
            </Field>
          )}
          {actionType === "START_LEAD_FLOW" && (
            <Field label="Lead flow">
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
            <Field label="New status">
              <Select value={leadStatus} onChange={(e) => setLeadStatus(e.target.value)}>
                {["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create automation"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
