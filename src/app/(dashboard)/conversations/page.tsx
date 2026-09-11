"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Bot,
  ChevronLeft,
  Clock,
  Cpu,
  FlaskConical,
  Instagram,
  MessagesSquare,
  Search,
  Send,
  ShieldCheck,
  User,
  Zap,
} from "lucide-react";
import { cn, formatDate, timeAgo } from "@/lib/utils";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { useAccounts } from "@/components/shell/account-context";
import { Card, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Segmented, Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/page-header";

/**
 * Conversations + human handoff (spec §24–25) — a two-pane DM inbox.
 * Left: searchable, filterable conversation list. Right: the thread with
 * chat bubbles, AI/human state, and the admin composer.
 * On mobile only one pane is visible at a time (list → thread → back).
 */

interface ConvRow {
  id: string;
  igsid: string;
  username: string | null;
  status: "OPEN" | "HUMAN" | "CLOSED";
  aiEnabled: boolean;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  isDemo: boolean;
  leadId: string | null;
  agent: { id: string; name: string } | null;
  _count: { messages: number };
}

interface MessageRow {
  id: string;
  direction: "IN" | "OUT";
  sender: "CUSTOMER" | "AI" | "ADMIN" | "SYSTEM";
  text: string | null;
  createdAt: string;
  aiLatencyMs: number | null;
}

interface ConvDetail {
  conversation: ConvRow & {
    account: { id: string; username: string; isDemo: boolean };
    messages: MessageRow[];
    flowSessions: Array<{ id: string; status: string; flow: { name: string } }>;
  };
  lead: { id: string; name: string | null; phone: string | null; status: string } | null;
  messagingWindowOpen: boolean;
}

type StatusFilter = "" | "OPEN" | "HUMAN";

export default function ConversationsPage() {
  const { d } = useI18n();
  const { selected, loading: accountsLoading } = useAccounts();

  const [rows, setRows] = React.useState<ConvRow[] | null>(null);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<ConvDetail | null>(null);
  const [filter, setFilter] = React.useState<StatusFilter>("");
  const [q, setQ] = React.useState("");
  /** Mobile-only: the thread pane is shown after the user taps a conversation. */
  const [mobileThread, setMobileThread] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!selected) return;
    const data = await api<{ conversations: ConvRow[] }>(
      `/api/conversations?accountId=${selected.id}${filter ? `&status=${filter}` : ""}${q ? `&q=${encodeURIComponent(q)}` : ""}`,
      { silent: true },
    );
    setRows(data.conversations);
    if (!activeId && data.conversations[0]) setActiveId(data.conversations[0].id);
  }, [selected, filter, q, activeId]);

  const loadDetail = React.useCallback(async () => {
    if (!activeId) return;
    const data = await api<ConvDetail>(`/api/conversations/${activeId}`, { silent: true });
    setDetail(data);
  }, [activeId]);

  React.useEffect(() => {
    void load();
  }, [load]);
  React.useEffect(() => {
    void loadDetail();
    const t = setInterval(loadDetail, 10_000);
    return () => clearInterval(t);
  }, [loadDetail]);

  if (accountsLoading) {
    return <div className="py-20 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</div>;
  }

  if (!selected) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <InboxHeader />
        <EmptyState
          icon={
            <IconChip color="var(--color-mod-instagram)" size={48}>
              <Instagram size={22} />
            </IconChip>
          }
          title={d.shell.noAccount}
          action={
            <Button asChild variant="instagram">
              <Link href="/instagram">{d.instagram.connectButton}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <InboxHeader />

      <div className="flex min-h-0 flex-1 gap-4">
        {/* LEFT: conversation list */}
        <Card
          className={cn(
            "w-full flex-col overflow-hidden md:w-80 md:shrink-0",
            mobileThread ? "hidden md:flex" : "flex",
          )}
        >
          <div className="shrink-0 space-y-2 border-b border-(--color-border) p-3">
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-(--color-fg-faint)"
                aria-hidden
              />
              <Input
                className="pl-8"
                placeholder={d.conversations.searchPh}
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "", label: d.conversations.filterAll },
                { value: "OPEN", label: d.conversations.filterOpen },
                { value: "HUMAN", label: d.conversations.filterHuman },
              ]}
            />
          </div>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
            {rows === null && (
              <p className="p-3 text-center text-xs text-(--color-fg-muted)">{d.common.loading}</p>
            )}
            {rows?.length === 0 && (
              <div className="p-1">
                <EmptyState title={d.conversations.empty} />
              </div>
            )}
            {rows?.map((c) => (
              <ConversationRow
                key={c.id}
                c={c}
                active={activeId === c.id}
                onSelect={() => {
                  setActiveId(c.id);
                  setMobileThread(true);
                }}
              />
            ))}
          </div>
        </Card>

        {/* RIGHT: thread */}
        <Card className={cn("min-w-0 flex-1 flex-col overflow-hidden", mobileThread ? "flex" : "hidden md:flex")}>
          {detail ? (
            <ConversationThread
              detail={detail}
              onBack={() => setMobileThread(false)}
              onChanged={async () => {
                await loadDetail();
                await load();
              }}
            />
          ) : (
            <div className="grid flex-1 place-items-center p-6">
              <div className="flex flex-col items-center gap-2.5 text-center">
                <IconChip color="var(--color-mod-content)" size={44}>
                  <MessagesSquare size={20} />
                </IconChip>
                <p className="text-xs text-(--color-fg-muted)">{d.conversations.subtitle}</p>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ---------- header ---------- */

function InboxHeader() {
  const { d } = useI18n();
  return (
    <div className="mb-3 flex shrink-0 items-center gap-2.5">
      <IconChip color="var(--color-mod-content)">
        <MessagesSquare size={16} />
      </IconChip>
      <div className="min-w-0">
        <h1 className="text-base font-bold leading-tight tracking-tight">{d.conversations.title}</h1>
        <p className="truncate text-[11px] text-(--color-fg-muted)">{d.conversations.subtitle}</p>
      </div>
    </div>
  );
}

/* ---------- list row ---------- */

function ConversationRow({ c, active, onSelect }: { c: ConvRow; active: boolean; onSelect: () => void }) {
  const { d } = useI18n();
  const human = c.status === "HUMAN" || !c.aiEnabled;
  const name = c.username ?? c.igsid;
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors",
        active ? "border-(--color-accent)/40 bg-(--color-accent-soft)" : "border-transparent hover:bg-(--color-panel-2)",
      )}
    >
      <span
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-(--color-accent-soft) text-xs font-bold text-(--color-accent)"
        aria-hidden
      >
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[13px] font-semibold">{name}</span>
          <span className="shrink-0 text-[10px] text-(--color-fg-faint)">{timeAgo(c.lastMessageAt)}</span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span
            title={human ? d.conversations.youActive : d.conversations.aiActive}
            className={cn("shrink-0", human ? "text-(--color-warn)" : "text-(--color-mod-ai)")}
          >
            {human ? <User size={12} /> : <Bot size={12} />}
          </span>
          <span className="truncate text-[11px] text-(--color-fg-muted)">{c.lastMessagePreview}</span>
        </span>
        {(c.leadId !== null || c.isDemo) && (
          <span className="mt-1 flex flex-wrap items-center gap-1">
            {c.leadId !== null && (
              <Badge tone="ok" className="px-1 py-0 text-[10px]">
                {d.conversations.isLead}
              </Badge>
            )}
            {c.isDemo && (
              <Badge tone="warn" className="px-1 py-0 text-[10px] uppercase">
                {d.shell.demo}
              </Badge>
            )}
          </span>
        )}
      </span>
    </button>
  );
}

/* ---------- thread ---------- */

function ConversationThread({
  detail,
  onChanged,
  onBack,
}: {
  detail: ConvDetail;
  onChanged: () => Promise<void>;
  onBack: () => void;
}) {
  const { d } = useI18n();
  const conv = detail.conversation;
  const human = conv.status === "HUMAN" || !conv.aiEnabled;
  const windowOpen = detail.messagingWindowOpen;
  const name = conv.username ?? conv.igsid;

  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [simBusy, setSimBusy] = React.useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [conv.id, conv.messages.length]);

  async function send() {
    if (busy || !text.trim() || !windowOpen) return;
    setBusy(true);
    try {
      await api(`/api/conversations/${conv.id}/send`, { method: "POST", json: { text } });
      setText("");
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function simulateInbound() {
    const msg = prompt(d.conversations.simulate, "kurs");
    if (!msg) return;
    setSimBusy(true);
    try {
      await api("/api/dev/simulate", {
        method: "POST",
        json: { accountId: conv.account.id, igsid: conv.igsid, text: msg },
      });
      toast.success(d.common.done);
      setTimeout(onChanged, 1500);
    } finally {
      setSimBusy(false);
    }
  }

  async function toggleAi(takeover: boolean) {
    await api(`/api/conversations/${conv.id}/${takeover ? "takeover" : "return-to-ai"}`, { method: "POST" });
    toast.success(takeover ? d.conversations.youActive : d.conversations.aiActive);
    await onChanged();
  }

  return (
    <>
      {/* thread header */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-(--color-border) px-3 py-2.5 sm:px-4">
        <Button
          variant="ghost"
          size="icon"
          className="-ml-1 h-8 w-8 shrink-0 md:hidden"
          onClick={onBack}
          aria-label={d.common.back}
        >
          <ChevronLeft size={18} />
        </Button>
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-(--color-accent-soft) text-xs font-bold text-(--color-accent)"
          aria-hidden
        >
          {name.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-semibold">{name}</span>
            {conv.isDemo && (
              <Badge tone="warn" className="uppercase">
                {d.shell.demo}
              </Badge>
            )}
            {(detail.lead !== null || conv.leadId !== null) && (
              <Badge tone="ok">
                {d.conversations.isLead}
                {detail.lead?.name ? ` · ${detail.lead.name}` : detail.lead?.phone ? ` · ${detail.lead.phone}` : ""}
              </Badge>
            )}
          </div>
          <div className="truncate text-[11px] text-(--color-fg-faint)">
            @{conv.account.username}
            {conv.agent ? ` · ${conv.agent.name}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {human ? (
            <Badge tone="warn" className="px-2 py-1">
              <User size={12} /> {d.conversations.youActive}
            </Badge>
          ) : (
            <Badge tone="accent" className="px-2 py-1">
              <Bot size={12} /> {d.conversations.aiActive}
            </Badge>
          )}
          {human ? (
            <Button size="sm" variant="success" onClick={() => void toggleAi(false)}>
              {d.conversations.returnToAi}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => void toggleAi(true)}>
              {d.conversations.takeOver}
            </Button>
          )}
          {process.env.NODE_ENV !== "production" && (
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8"
              onClick={() => void simulateInbound()}
              disabled={simBusy}
              title={d.conversations.simulate}
              aria-label={d.conversations.simulate}
            >
              <FlaskConical size={15} />
            </Button>
          )}
        </div>
      </div>

      {/* messages */}
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-4 sm:px-5">
        {conv.flowSessions
          .filter((s) => s.status === "ACTIVE")
          .map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-(--color-accent)/25 bg-(--color-accent-soft) px-3 py-1.5 text-[11px] font-medium text-(--color-accent)"
            >
              <Zap size={12} className="shrink-0" />
              <span className="truncate">{s.flow.name}</span>
              <span className="shrink-0">· {d.common.active}</span>
            </div>
          ))}
        {conv.messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* composer */}
      <div className="shrink-0 border-t border-(--color-border) p-3">
        {!windowOpen && (
          <div className="mb-2.5 flex items-start gap-2 rounded-lg bg-(--color-warn-soft) px-3 py-2 text-xs leading-5 text-(--color-warn)">
            <Clock size={14} className="mt-0.5 shrink-0" />
            {d.conversations.windowClosed}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            className="min-h-0 resize-none"
            placeholder={d.conversations.composerPh}
            value={text}
            disabled={!windowOpen}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button onClick={() => void send()} disabled={busy || !text.trim() || !windowOpen}>
            <Send size={15} /> {d.conversations.sendBtn}
          </Button>
        </div>
      </div>
    </>
  );
}

/* ---------- bubble ---------- */

function MessageBubble({ m }: { m: MessageRow }) {
  const mine = m.direction === "OUT";
  const Icon = m.sender === "AI" ? Bot : m.sender === "ADMIN" ? ShieldCheck : m.sender === "SYSTEM" ? Cpu : User;
  return (
    <div className={cn("flex flex-col", mine ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-5 sm:max-w-[70%]",
          mine
            ? m.sender === "AI"
              ? "rounded-br-md bg-(--color-mod-ai) text-white"
              : "rounded-br-md bg-(--color-accent) text-white"
            : "rounded-bl-md bg-(--color-panel-2) text-(--color-fg)",
        )}
      >
        {m.text ?? "—"}
      </div>
      <div className="mt-1 flex items-center gap-1 px-1 text-[10px] text-(--color-fg-faint)">
        <Icon size={11} aria-hidden />
        <span>{formatDate(m.createdAt)}</span>
        {m.aiLatencyMs != null && <span>· {(m.aiLatencyMs / 1000).toFixed(1)}s</span>}
      </div>
    </div>
  );
}
