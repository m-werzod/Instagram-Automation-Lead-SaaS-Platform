"use client";

import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useAccounts } from "@/components/shell/account-context";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

/** CRM kanban (spec §21). Status moves via the select on each card + detail drawer. */

const STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"] as const;
type Status = (typeof STATUSES)[number];

const STATUS_COLOR: Record<Status, string> = {
  NEW: "border-t-[--color-accent]",
  CONTACTED: "border-t-[--color-warn]",
  QUALIFIED: "border-t-[--color-ok]",
  IN_PROGRESS: "border-t-purple-400",
  WON: "border-t-[--color-ok]",
  LOST: "border-t-[--color-danger]",
};

interface LeadRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  status: Status;
  source: string;
  isDemo: boolean;
  createdAt: string;
  answers: Array<{ question: string; answer: string }> | { items?: Array<{ question: string; answer: string }> } | null;
  notes: string | null;
  account: { username: string };
  campaign: { id: string; name: string } | null;
  flow: { id: string; name: string } | null;
}

export default function LeadsPage() {
  const { selected } = useAccounts();
  const [leads, setLeads] = React.useState<LeadRow[] | null>(null);
  const [q, setQ] = React.useState("");
  const [detail, setDetail] = React.useState<LeadRow | null>(null);
  const [createOpen, setCreateOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!selected) return;
    const data = await api<{ leads: LeadRow[] }>(
      `/api/leads?accountId=${selected.id}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
      { silent: true },
    );
    setLeads(data.leads);
  }, [selected, q]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function move(lead: LeadRow, status: Status) {
    setLeads((prev) => prev?.map((l) => (l.id === lead.id ? { ...l, status } : l)) ?? null);
    try {
      await api(`/api/leads/${lead.id}`, { method: "PATCH", json: { status } });
    } catch {
      await load();
    }
  }

  if (!selected) return <p className="text-sm text-[--color-fg-muted]">Connect an Instagram account first.</p>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Leads · CRM</h1>
          <p className="text-xs text-[--color-fg-muted]">@{selected.username} · {leads?.length ?? "…"} leads</p>
        </div>
        <div className="flex gap-2">
          <Input placeholder="Search name / phone / email" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
          <Button onClick={() => setCreateOpen(true)}>Add lead</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 overflow-x-auto md:grid-cols-3 xl:grid-cols-6">
        {STATUSES.map((status) => {
          const col = leads?.filter((l) => l.status === status) ?? [];
          return (
            <div key={status} className="min-w-0">
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-xs font-semibold tracking-wide">{status}</span>
                <Badge>{col.length}</Badge>
              </div>
              <div className="space-y-2">
                {col.map((lead) => (
                  <Card key={lead.id} className={cn("border-t-2 cursor-pointer hover:border-[--color-border-strong]", STATUS_COLOR[status])}>
                    <CardBody className="space-y-1.5 p-3" onClick={() => setDetail(lead)}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{lead.name ?? "Unnamed lead"}</span>
                        {lead.isDemo && <Badge tone="warn">DEMO</Badge>}
                      </div>
                      {lead.phone && <div className="font-mono text-[11px] text-[--color-fg-muted]">{lead.phone}</div>}
                      <div className="flex items-center justify-between text-[10px] text-[--color-fg-faint]">
                        <span>{lead.source}</span>
                        <span>{formatDate(lead.createdAt).split(",")[0]}</span>
                      </div>
                      <Select
                        className="h-7 text-[11px]"
                        value={lead.status}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => move(lead, e.target.value as Status)}
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </Select>
                    </CardBody>
                  </Card>
                ))}
                {col.length === 0 && <div className="rounded border border-dashed border-[--color-border] p-3 text-center text-[11px] text-[--color-fg-faint]">empty</div>}
              </div>
            </div>
          );
        })}
      </div>

      {detail && <LeadDetailDialog lead={detail} onClose={() => setDetail(null)} onChanged={load} />}
      <CreateLeadDialog open={createOpen} onOpenChange={setCreateOpen} accountId={selected.id} onCreated={load} />
    </div>
  );
}

function LeadDetailDialog({ lead, onClose, onChanged }: { lead: LeadRow; onClose: () => void; onChanged: () => Promise<void> }) {
  const [notes, setNotes] = React.useState(lead.notes ?? "");
  const [events, setEvents] = React.useState<Array<{ id: string; type: string; createdAt: string; data: unknown }>>([]);
  const [emails, setEmails] = React.useState<Array<{ id: string; status: string; subject: string; lastError: string | null }>>([]);

  React.useEffect(() => {
    api<{ lead: { events: Array<{ id: string; type: string; createdAt: string; data: unknown }> }; emails: Array<{ id: string; status: string; subject: string; lastError: string | null }> }>(
      `/api/leads/${lead.id}`,
      { silent: true },
    )
      .then((d) => {
        setEvents(d.lead.events);
        setEmails(d.emails);
      })
      .catch(() => undefined);
  }, [lead.id]);

  const answers = Array.isArray(lead.answers) ? lead.answers : (lead.answers?.items ?? []);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent wide title={lead.name ?? "Lead"} description={`Source: ${lead.source} · @${lead.account.username} · ${formatDate(lead.createdAt)}`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2 text-sm">
            <div><span className="text-[--color-fg-faint]">Phone:</span> {lead.phone ?? "—"}</div>
            <div><span className="text-[--color-fg-faint]">Email:</span> {lead.email ?? "—"}</div>
            <div><span className="text-[--color-fg-faint]">Campaign:</span> {lead.campaign?.name ?? "—"}</div>
            <div><span className="text-[--color-fg-faint]">Lead flow:</span> {lead.flow?.name ?? "—"}</div>
            {answers.length > 0 && (
              <div className="rounded-md border border-[--color-border] bg-[--color-panel-2] p-2 text-xs">
                <div className="mb-1 font-semibold">Answers</div>
                {answers.map((a, i) => (
                  <div key={i} className="flex justify-between gap-2 py-0.5">
                    <span className="text-[--color-fg-muted]">{a.question}</span>
                    <span className="text-right font-medium">{a.answer}</span>
                  </div>
                ))}
              </div>
            )}
            <div>
              <Field label="Notes">
                <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
              <Button
                size="sm"
                className="mt-1"
                onClick={async () => {
                  await api(`/api/leads/${lead.id}`, { method: "PATCH", json: { notes } });
                  toast.success("Notes saved");
                  await onChanged();
                }}
              >
                Save notes
              </Button>
            </div>
          </div>
          <div className="space-y-3 text-xs">
            <div>
              <div className="mb-1 font-semibold">Email notifications</div>
              {emails.length === 0 && <p className="text-[--color-fg-faint]">none</p>}
              {emails.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-2 border-b border-[--color-border] py-1">
                  <span className="truncate">{e.subject}</span>
                  <Badge tone={e.status === "SENT" ? "ok" : e.status === "FAILED" ? "danger" : "warn"}>{e.status}</Badge>
                </div>
              ))}
            </div>
            <div>
              <div className="mb-1 font-semibold">Timeline</div>
              {events.map((ev) => (
                <div key={ev.id} className="flex items-center justify-between border-b border-[--color-border] py-1">
                  <span>{ev.type}</span>
                  <span className="text-[--color-fg-faint]">{formatDate(ev.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CreateLeadDialog({ open, onOpenChange, accountId, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; accountId: string; onCreated: () => Promise<void> }) {
  const [name, setName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [notify, setNotify] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/leads", {
        method: "POST",
        json: { accountId, name: name || undefined, phone: phone || undefined, email: email || undefined, notify },
      });
      toast.success("Lead created");
      onOpenChange(false);
      setName(""); setPhone(""); setEmail("");
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add lead manually">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Phone"><Input value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
          <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            Send the lead notification email
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Create lead"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
