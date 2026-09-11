"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Users,
  Plus,
  Search,
  Phone,
  Mail,
  MessageCircle,
  MousePointerClick,
  Instagram,
  ClipboardList,
  History,
  MailCheck,
  CalendarClock,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { useAccounts } from "@/components/shell/account-context";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { Card, CardBody, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/input";
import { ToggleRow } from "@/components/ui/switch";
import type { Dictionary } from "@/lib/i18n/dictionaries";

/**
 * CRM kanban (spec §21). Six status columns; a lead moves stages via the
 * select on its card or inside the detail dialog. Click a card for answers,
 * notes, email notifications and the event timeline.
 */

const STATUSES = ["NEW", "CONTACTED", "QUALIFIED", "IN_PROGRESS", "WON", "LOST"] as const;
type Status = (typeof STATUSES)[number];

type BadgeTone = "accent" | "info" | "warn" | "ok" | "danger";

/** Column hue + count-badge tone. IN_PROGRESS has no Badge tone → inline style. */
const STATUS_META: Record<Status, { color: string; tone: BadgeTone | null }> = {
  NEW: { color: "#4f46e5", tone: "accent" },
  CONTACTED: { color: "#0e7fa8", tone: "info" },
  QUALIFIED: { color: "#d97706", tone: "warn" },
  IN_PROGRESS: { color: "#7c3aed", tone: null },
  WON: { color: "#16a34a", tone: "ok" },
  LOST: { color: "#dc2626", tone: "danger" },
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
  conversationId: string | null;
  answers: Array<{ question: string; answer: string }> | { items?: Array<{ question: string; answer: string }> } | null;
  notes: string | null;
  account: { username: string };
  campaign: { id: string; name: string } | null;
  flow: { id: string; name: string } | null;
}

function sourceLabel(d: Dictionary, source: string): string {
  return (d.leads.sources as Record<string, string>)[source] ?? source;
}

/** "11 Sep 2026" — the date part of the shared formatter. */
function shortDate(iso: string): string {
  return formatDate(iso).split(",")[0] ?? "—";
}

export default function LeadsPage() {
  const { d } = useI18n();
  const { selected, loading: accountsLoading } = useAccounts();
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

  /* ---------- guards ---------- */

  if (accountsLoading) {
    return <div className="py-20 text-center text-sm text-[--color-fg-muted]">{d.common.loading}</div>;
  }

  if (!selected) {
    return (
      <>
        <PageHeader title={d.leads.title} description={d.leads.subtitle} accent="var(--color-mod-leads)" />
        <EmptyState
          icon={<IconChip color="var(--color-mod-instagram)" size={48}><Instagram size={22} /></IconChip>}
          title={d.leadButton.notReady}
          action={
            <Button asChild variant="instagram">
              <Link href="/instagram">{d.leadButton.goConnect}</Link>
            </Button>
          }
        />
      </>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={d.leads.title}
        description={d.leads.subtitle}
        accent="var(--color-mod-leads)"
        actions={
          <>
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[--color-fg-faint]"
              />
              <Input
                className="w-52 pl-8 sm:w-64"
                placeholder={d.leads.searchPh}
                aria-label={d.common.search}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={15} /> {d.leads.addLead}
            </Button>
          </>
        }
      />

      {leads === null ? (
        <div className="py-20 text-center text-sm text-[--color-fg-muted]">{d.common.loading}</div>
      ) : leads.length === 0 && q.trim() === "" ? (
        <EmptyState
          icon={<IconChip color="var(--color-mod-leads)" size={48}><Users size={22} /></IconChip>}
          title={d.leads.empty}
          action={
            <Button asChild>
              <Link href="/lead-button">
                <MousePointerClick size={14} /> {d.leads.goLeadButton}
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="grid grid-flow-col auto-cols-[minmax(16rem,1fr)] gap-3 overflow-x-auto pb-2">
          {STATUSES.map((status) => {
            const meta = STATUS_META[status];
            const col = leads.filter((l) => l.status === status);
            return (
              <div
                key={status}
                className="flex min-h-44 flex-col overflow-hidden rounded-xl border border-[--color-border] bg-[--color-panel-2]/60"
              >
                {/* colored top bar */}
                <div className="h-1 shrink-0" style={{ background: meta.color }} aria-hidden />
                <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                  <span className="truncate text-xs font-semibold tracking-wide" style={{ color: meta.color }}>
                    {d.leads.statuses[status]}
                  </span>
                  {meta.tone ? (
                    <Badge tone={meta.tone}>{col.length}</Badge>
                  ) : (
                    <Badge
                      style={{
                        background: `color-mix(in srgb, ${meta.color} 12%, white)`,
                        color: meta.color,
                        borderColor: `color-mix(in srgb, ${meta.color} 30%, white)`,
                      }}
                    >
                      {col.length}
                    </Badge>
                  )}
                </div>
                <div className="flex-1 space-y-2 px-2 pb-2">
                  {col.map((lead) => (
                    <LeadCard key={lead.id} lead={lead} d={d} onOpen={() => setDetail(lead)} onMove={(s) => void move(lead, s)} />
                  ))}
                  {col.length === 0 && (
                    <div className="rounded-lg border border-dashed border-[--color-border-strong] py-6 text-center text-[11px] text-[--color-fg-faint]">
                      {d.common.none}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {detail && <LeadDetailDialog lead={detail} onClose={() => setDetail(null)} onChanged={load} />}
      <CreateLeadDialog open={createOpen} onOpenChange={setCreateOpen} accountId={selected.id} onCreated={load} />
    </div>
  );
}

/* ---------- kanban card ---------- */

function LeadCard({
  lead,
  d,
  onOpen,
  onMove,
}: {
  lead: LeadRow;
  d: Dictionary;
  onOpen: () => void;
  onMove: (s: Status) => void;
}) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer transition-all hover:-translate-y-px hover:border-[--color-border-strong] hover:shadow-md"
    >
      <CardBody className="space-y-2 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-semibold">{lead.name ?? "—"}</span>
          {lead.isDemo && (
            <Badge tone="warn" className="shrink-0 uppercase">
              {d.shell.demo}
            </Badge>
          )}
        </div>

        {(lead.phone || lead.email) && (
          <div className="space-y-0.5">
            {lead.phone && (
              <div className="flex items-center gap-1.5 text-[11px] text-[--color-fg-muted]">
                <Phone size={11} className="shrink-0 text-[--color-fg-faint]" />
                <span className="truncate font-mono">{lead.phone}</span>
              </div>
            )}
            {lead.email && (
              <div className="flex items-center gap-1.5 text-[11px] text-[--color-fg-muted]">
                <Mail size={11} className="shrink-0 text-[--color-fg-faint]" />
                <span className="truncate">{lead.email}</span>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2">
          <Badge className="min-w-0 truncate">{sourceLabel(d, lead.source)}</Badge>
          <span className="shrink-0 text-[10px] text-[--color-fg-faint]">{shortDate(lead.createdAt)}</span>
        </div>

        <Select
          className="h-7 text-[11px]"
          value={lead.status}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => onMove(e.target.value as Status)}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {d.leads.statuses[s]}
            </option>
          ))}
        </Select>
      </CardBody>
    </Card>
  );
}

/* ---------- detail dialog ---------- */

function LeadDetailDialog({
  lead,
  onClose,
  onChanged,
}: {
  lead: LeadRow;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { d } = useI18n();
  const [status, setStatus] = React.useState<Status>(lead.status);
  const [notes, setNotes] = React.useState(lead.notes ?? "");
  const [savingNotes, setSavingNotes] = React.useState(false);
  const [events, setEvents] = React.useState<Array<{ id: string; type: string; createdAt: string; data: unknown }>>([]);
  const [emails, setEmails] = React.useState<Array<{ id: string; status: string; subject: string; lastError: string | null }>>([]);

  React.useEffect(() => {
    api<{
      lead: { events: Array<{ id: string; type: string; createdAt: string; data: unknown }> };
      emails: Array<{ id: string; status: string; subject: string; lastError: string | null }>;
    }>(`/api/leads/${lead.id}`, { silent: true })
      .then((res) => {
        setEvents(res.lead.events);
        setEmails(res.emails);
      })
      .catch(() => undefined);
  }, [lead.id]);

  const answers = Array.isArray(lead.answers) ? lead.answers : (lead.answers?.items ?? []);

  async function changeStatus(next: Status) {
    const prev = status;
    setStatus(next);
    try {
      await api(`/api/leads/${lead.id}`, { method: "PATCH", json: { status: next } });
      await onChanged();
    } catch {
      setStatus(prev);
    }
  }

  async function saveNotes() {
    setSavingNotes(true);
    try {
      await api(`/api/leads/${lead.id}`, { method: "PATCH", json: { notes } });
      toast.success(d.common.saved);
      await onChanged();
    } finally {
      setSavingNotes(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        wide
        title={lead.name ?? "—"}
        description={`${d.leads.source}: ${sourceLabel(d, lead.source)} · @${lead.account.username}`}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          {/* LEFT: status, contact, answers, notes */}
          <div className="space-y-4">
            <Field label={d.common.status}>
              <Select value={status} onChange={(e) => void changeStatus(e.target.value as Status)}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {d.leads.statuses[s]}
                  </option>
                ))}
              </Select>
            </Field>

            <div className="rounded-xl border border-[--color-border] bg-[--color-panel-2] px-3 py-1.5">
              <InfoRow icon={<Phone size={13} />} label={d.leads.detail.phone} value={lead.phone} mono />
              <InfoRow icon={<Mail size={13} />} label={d.leads.detail.email} value={lead.email} />
              <InfoRow icon={<CalendarClock size={13} />} label={d.leads.detail.created} value={formatDate(lead.createdAt)} />
            </div>

            {(lead.campaign || lead.flow || lead.conversationId) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {lead.campaign && <Badge tone="info">{lead.campaign.name}</Badge>}
                {lead.flow && <Badge tone="accent">{lead.flow.name}</Badge>}
                {lead.conversationId && (
                  <Button asChild size="sm" variant="secondary">
                    <Link href="/conversations">
                      <MessageCircle size={13} /> {d.leads.detail.openChat}
                    </Link>
                  </Button>
                )}
              </div>
            )}

            {answers.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-[--color-border]">
                <div className="flex items-center gap-1.5 border-b border-[--color-border] bg-[--color-panel-2] px-3 py-2 text-xs font-semibold">
                  <ClipboardList size={13} className="text-[--color-fg-faint]" /> {d.leads.detail.answers}
                </div>
                <div className="divide-y divide-[--color-border] px-3 text-xs">
                  {answers.map((a, i) => (
                    <div key={i} className="flex items-start justify-between gap-3 py-1.5">
                      <span className="text-[--color-fg-muted]">{a.question}</span>
                      <span className="text-right font-medium">{a.answer}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <Field label={d.leads.detail.notes}>
                <Textarea rows={3} placeholder={d.leads.detail.notesPh} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
              <Button size="sm" className="mt-2" disabled={savingNotes} onClick={() => void saveNotes()}>
                {savingNotes ? d.common.saving : d.common.save}
              </Button>
            </div>
          </div>

          {/* RIGHT: email notifications + timeline */}
          <div className="space-y-4 text-xs">
            <div>
              <div className="mb-2 flex items-center gap-1.5 font-semibold">
                <MailCheck size={13} className="text-[--color-fg-faint]" /> {d.leads.detail.emails}
              </div>
              {emails.length === 0 && <p className="text-[--color-fg-faint]">{d.common.none}</p>}
              {emails.map((e) => (
                <div key={e.id} className="flex items-center justify-between gap-2 border-b border-[--color-border] py-1.5 last:border-0">
                  <span className="min-w-0 truncate" title={e.lastError ?? undefined}>
                    {e.subject}
                  </span>
                  <Badge tone={e.status === "SENT" ? "ok" : e.status === "FAILED" ? "danger" : "warn"}>{e.status}</Badge>
                </div>
              ))}
            </div>

            <div>
              <div className="mb-2 flex items-center gap-1.5 font-semibold">
                <History size={13} className="text-[--color-fg-faint]" /> {d.leads.detail.timeline}
              </div>
              {events.length === 0 && <p className="text-[--color-fg-faint]">{d.common.none}</p>}
              {events.map((ev) => (
                <div key={ev.id} className="flex items-center justify-between gap-2 border-b border-[--color-border] py-1.5 last:border-0">
                  <span className="font-medium">{ev.type}</span>
                  <span className="shrink-0 text-[--color-fg-faint]">{formatDate(ev.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InfoRow({ icon, label, value, mono }: { icon: React.ReactNode; label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-1.5">
      <span className="shrink-0 text-[--color-fg-faint]">{icon}</span>
      <span className="w-20 shrink-0 text-xs text-[--color-fg-muted]">{label}</span>
      <span className={cn("min-w-0 flex-1 truncate text-[13px] font-medium", mono && "font-mono text-xs")}>{value ?? "—"}</span>
    </div>
  );
}

/* ---------- create dialog ---------- */

function CreateLeadDialog({
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
      toast.success(d.common.saved);
      onOpenChange(false);
      setName("");
      setPhone("");
      setEmail("");
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={d.leads.newLead.title}>
        <form onSubmit={submit} className="space-y-3">
          <Field label={d.leads.newLead.name}>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={d.leads.newLead.phone}>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label={d.leads.newLead.email}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <ToggleRow
            label={d.leads.newLead.notify}
            checked={notify}
            onCheckedChange={setNotify}
            onLabel={d.common.on}
            offLabel={d.common.off}
          />
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {d.common.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? d.common.saving : d.common.create}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
