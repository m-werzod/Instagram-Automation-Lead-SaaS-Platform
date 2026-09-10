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
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui/page-header";

/** Question builder + one-question-per-step flow config (spec §17–19). */

const QUESTION_TYPES = ["TEXT", "PHONE", "EMAIL", "NUMBER", "SINGLE_SELECT", "MULTI_SELECT", "DATE", "TIME", "BOOLEAN"] as const;
type QType = (typeof QUESTION_TYPES)[number];

interface Question {
  title: string;
  prompt: string;
  type: QType;
  required: boolean;
  options: string[];
  mapTo: "name" | "phone" | "email" | null;
}

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  triggerKeywords: string[];
  completionMessage: string | null;
  isDemo: boolean;
  questions: Array<Question & { id: string; order: number }>;
  _count: { sessions: number; leads: number };
}

export default function LeadFlowsPage() {
  const { selected } = useAccounts();
  const [flows, setFlows] = React.useState<FlowRow[] | null>(null);
  const [editing, setEditing] = React.useState<FlowRow | "new" | null>(null);

  const load = React.useCallback(async () => {
    if (!selected) return;
    const data = await api<{ flows: FlowRow[] }>(`/api/lead-flows?accountId=${selected.id}`, { silent: true });
    setFlows(data.flows);
  }, [selected]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function toggle(flow: FlowRow, enabled: boolean) {
    setFlows((prev) => prev?.map((f) => (f.id === flow.id ? { ...f, enabled } : f)) ?? null);
    try {
      await api(`/api/lead-flows/${flow.id}`, { method: "PATCH", json: { enabled } });
      toast.success(`Flow "${flow.name}" ${enabled ? "enabled" : "disabled"}`);
    } catch {
      await load();
    }
  }

  if (!selected) return <p className="text-sm text-[--color-fg-muted]">Connect an Instagram account first.</p>;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Lead Forms"
        description="Questionnaires that run inside Instagram DMs — one question per message, each answer checked and saved before the next is sent. A finished form becomes a lead in your CRM and emails you. Started by a keyword, an AI agent, or an automation."
        accent="var(--color-mod-ai)"
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus size={15} /> New form
          </Button>
        }
      />

      {flows?.length === 0 && (
        <EmptyState
          title="No lead forms yet"
          description="Build the questions you want to ask people who message you — for example name, phone number and which service they want."
          action={<Button onClick={() => setEditing("new")}>Build your first form</Button>}
        />
      )}

      {flows?.map((flow) => (
        <Card key={flow.id}>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                {flow.name}
                {flow.isDemo && <Badge tone="warn">DEMO</Badge>}
              </span>
            }
            description={`${flow.questions.length} questions · ${flow._count.leads} leads · keywords: ${flow.triggerKeywords.join(", ") || "—"}`}
            actions={
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-semibold ${flow.enabled ? "text-[--color-on]" : "text-[--color-off]"}`}>
                    {flow.enabled ? "ON" : "OFF"}
                  </span>
                  <Switch checked={flow.enabled} onCheckedChange={(v) => toggle(flow, v)} />
                </div>
                <Button size="sm" variant="secondary" onClick={() => setEditing(flow)}>
                  Edit
                </Button>
              </div>
            }
          />
          <CardBody>
            <ol className="space-y-1">
              {flow.questions.map((q, i) => (
                <li key={q.id} className="flex items-center gap-2 text-xs">
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[--color-panel-2] text-[10px] text-[--color-fg-muted]">
                    {i + 1}
                  </span>
                  <span className="font-medium">{q.title}</span>
                  <Badge>{q.type}</Badge>
                  {q.mapTo && <Badge tone="accent">→ {q.mapTo}</Badge>}
                  {!q.required && <span className="text-[--color-fg-faint]">(optional)</span>}
                  {i < flow.questions.length - 1 && <span className="text-[--color-fg-faint]">↓</span>}
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      ))}

      {editing && (
        <FlowEditor
          accountId={selected.id}
          flow={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}
    </div>
  );
}

const EMPTY_Q: Question = { title: "", prompt: "", type: "TEXT", required: true, options: [], mapTo: null };

function FlowEditor({
  accountId,
  flow,
  onClose,
  onSaved,
}: {
  accountId: string;
  flow: FlowRow | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = React.useState(flow?.name ?? "Registration Flow");
  const [keywords, setKeywords] = React.useState(flow?.triggerKeywords.join(", ") ?? "sign up, register");
  const [completion, setCompletion] = React.useState(flow?.completionMessage ?? "Thank you! We received your details and will contact you shortly. ✅");
  const [questions, setQuestions] = React.useState<Question[]>(
    flow?.questions.map((q) => ({ title: q.title, prompt: q.prompt, type: q.type, required: q.required, options: q.options, mapTo: q.mapTo })) ?? [
      { ...EMPTY_Q, title: "Full Name", prompt: "What is your full name?", mapTo: "name" },
      { ...EMPTY_Q, title: "Phone", prompt: "What is your phone number?", type: "PHONE", mapTo: "phone" },
    ],
  );
  const [busy, setBusy] = React.useState(false);

  function update(i: number, patch: Partial<Question>) {
    setQuestions((prev) => prev.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));
  }
  function moveQ(i: number, dir: -1 | 1) {
    setQuestions((prev) => {
      const next = [...prev];
      const j = i + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }

  async function save() {
    const clean = questions
      .map((q) => ({
        ...q,
        title: q.title.trim(),
        prompt: q.prompt.trim(),
        options: q.type === "SINGLE_SELECT" || q.type === "MULTI_SELECT" ? q.options.filter(Boolean) : [],
      }))
      .filter((q) => q.title && q.prompt);
    if (clean.length === 0) {
      toast.error("Add at least one complete question (title + prompt)");
      return;
    }
    for (const q of clean) {
      if ((q.type === "SINGLE_SELECT" || q.type === "MULTI_SELECT") && q.options.length < 2) {
        toast.error(`"${q.title}": select questions need at least 2 options`);
        return;
      }
    }
    setBusy(true);
    try {
      const payload = {
        name,
        triggerKeywords: keywords.split(",").map((k) => k.trim()).filter(Boolean),
        completionMessage: completion || undefined,
        questions: clean,
      };
      if (flow) {
        await api(`/api/lead-flows/${flow.id}`, { method: "PATCH", json: payload });
        toast.success("Flow updated (active sessions were reset)");
      } else {
        await api("/api/lead-flows", { method: "POST", json: { accountId, ...payload } });
        toast.success("Flow created");
      }
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent wide title={flow ? `Edit flow: ${flow.name}` : "New lead flow"} description="One question per DM step. Selects with ≤13 short options render as Instagram quick replies; longer lists fall back to numbered text automatically.">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Flow name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Trigger keywords (comma-separated)" hint="A DM containing one of these starts the flow">
              <Input value={keywords} onChange={(e) => setKeywords(e.target.value)} />
            </Field>
          </div>
          <Field label="Completion message">
            <Textarea rows={2} value={completion} onChange={(e) => setCompletion(e.target.value)} />
          </Field>

          <div className="space-y-3">
            {questions.map((q, i) => (
              <div key={i} className="rounded-md border border-[--color-border] bg-[--color-panel-2] p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold">Question {i + 1}</span>
                  <div className="flex gap-1">
                    <Button size="icon" variant="ghost" onClick={() => moveQ(i, -1)} disabled={i === 0}>
                      <ArrowUp size={13} />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => moveQ(i, 1)} disabled={i === questions.length - 1}>
                      <ArrowDown size={13} />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => setQuestions((prev) => prev.filter((_, idx) => idx !== i))}>
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Title (internal)">
                    <Input value={q.title} onChange={(e) => update(i, { title: e.target.value })} placeholder="Full Name" />
                  </Field>
                  <Field label="Type">
                    <Select
                      value={q.type}
                      onChange={(e) => update(i, { type: e.target.value as QType })}
                    >
                      {QUESTION_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Question text sent to the user" className="sm:col-span-2">
                    <Textarea rows={2} value={q.prompt} onChange={(e) => update(i, { prompt: e.target.value })} placeholder="What is your full name?" />
                  </Field>
                  {(q.type === "SINGLE_SELECT" || q.type === "MULTI_SELECT") && (
                    <Field label="Options (comma-separated)" className="sm:col-span-2" hint="≤13 options of ≤20 chars → quick reply buttons; otherwise numbered list">
                      <Input
                        value={q.options.join(", ")}
                        onChange={(e) => update(i, { options: e.target.value.split(",").map((o) => o.trim()) })}
                        placeholder="Option A, Option B, Option C"
                      />
                    </Field>
                  )}
                  <Field label="Map answer to lead field">
                    <Select value={q.mapTo ?? ""} onChange={(e) => update(i, { mapTo: (e.target.value || null) as Question["mapTo"] })}>
                      <option value="">— store as answer only —</option>
                      <option value="name">name</option>
                      <option value="phone">phone</option>
                      <option value="email">email</option>
                    </Select>
                  </Field>
                  <label className="mt-5 flex items-center gap-2 text-xs">
                    <input type="checkbox" checked={q.required} onChange={(e) => update(i, { required: e.target.checked })} />
                    Required
                  </label>
                </div>
              </div>
            ))}
            <Button variant="secondary" size="sm" onClick={() => setQuestions((prev) => [...prev, { ...EMPTY_Q }])} disabled={questions.length >= 25}>
              <Plus size={14} /> Add question
            </Button>
          </div>

          <div className="flex justify-end gap-2 border-t border-[--color-border] pt-3">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : flow ? "Save changes" : "Create flow"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
