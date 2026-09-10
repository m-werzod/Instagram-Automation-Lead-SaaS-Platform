"use client";

import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useAccounts } from "@/components/shell/account-context";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select, Textarea } from "@/components/ui/input";
import { cn, formatDate, timeAgo } from "@/lib/utils";
import { Bot, User, ShieldCheck, Cpu } from "lucide-react";

/** Conversations + human handoff (spec §24–25). */

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

export default function ConversationsPage() {
  const { selected } = useAccounts();
  const [rows, setRows] = React.useState<ConvRow[] | null>(null);
  const [activeId, setActiveId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<ConvDetail | null>(null);
  const [filter, setFilter] = React.useState<"" | "OPEN" | "HUMAN">("");
  const [q, setQ] = React.useState("");

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

  if (!selected) return <p className="text-sm text-[--color-fg-muted]">Connect an Instagram account first.</p>;

  return (
    <div className="flex h-[calc(100dvh-7.5rem)] gap-4">
      {/* list */}
      <div className="flex w-72 shrink-0 flex-col gap-2">
        <div className="flex gap-2">
          <Input placeholder="Search user" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 text-xs" />
          <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="h-8 w-28 text-xs">
            <option value="">All</option>
            <option value="OPEN">AI active</option>
            <option value="HUMAN">Human</option>
          </Select>
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {rows?.length === 0 && <p className="p-3 text-xs text-[--color-fg-muted]">No conversations yet.</p>}
          {rows?.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={cn(
                "w-full rounded-md border px-3 py-2 text-left transition-colors",
                activeId === c.id
                  ? "border-[--color-accent]/60 bg-[--color-accent]/10"
                  : "border-[--color-border] bg-[--color-panel] hover:border-[--color-border-strong]",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium">{c.username ?? c.igsid}</span>
                <span className="text-[10px] text-[--color-fg-faint]">{timeAgo(c.lastMessageAt)}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                {c.status === "HUMAN" ? <Badge tone="warn">HUMAN</Badge> : <Badge tone={c.aiEnabled ? "ok" : "default"}>{c.aiEnabled ? "AI" : "AI off"}</Badge>}
                {c.leadId && <Badge tone="accent">lead</Badge>}
                {c.isDemo && <Badge tone="warn">DEMO</Badge>}
              </div>
              <p className="mt-1 truncate text-[11px] text-[--color-fg-muted]">{c.lastMessagePreview}</p>
            </button>
          ))}
        </div>
      </div>

      {/* detail */}
      <Card className="flex min-w-0 flex-1 flex-col">
        {!detail ? (
          <CardBody className="grid flex-1 place-items-center text-sm text-[--color-fg-muted]">Select a conversation</CardBody>
        ) : (
          <ConversationDetail detail={detail} onChanged={async () => { await loadDetail(); await load(); }} />
        )}
      </Card>
    </div>
  );
}

function ConversationDetail({ detail, onChanged }: { detail: ConvDetail; onChanged: () => Promise<void> }) {
  const conv = detail.conversation;
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [simBusy, setSimBusy] = React.useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [detail.conversation.messages.length]);

  async function send() {
    if (!text.trim()) return;
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
    const msg = prompt("Simulate an inbound DM from this user (dev only):", "kurs");
    if (!msg) return;
    setSimBusy(true);
    try {
      await api("/api/dev/simulate", {
        method: "POST",
        json: { accountId: conv.account.id, igsid: conv.igsid, text: msg },
      });
      toast.success("Inbound message queued — worker/inline queue will process it");
      setTimeout(onChanged, 1500);
    } finally {
      setSimBusy(false);
    }
  }

  async function toggleAi(takeover: boolean) {
    await api(`/api/conversations/${conv.id}/${takeover ? "takeover" : "return-to-ai"}`, { method: "POST" });
    toast.success(takeover ? "You took over — AI stopped responding here" : "Returned to AI");
    await onChanged();
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 border-b border-[--color-border] px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium">
            {conv.username ?? conv.igsid}
            {conv.isDemo && <Badge tone="warn">DEMO</Badge>}
            {detail.lead && (
              <Badge tone="accent">
                lead: {detail.lead.name ?? detail.lead.phone ?? detail.lead.id.slice(0, 6)} · {detail.lead.status}
              </Badge>
            )}
          </div>
          <div className="text-[11px] text-[--color-fg-faint]">
            @{conv.account.username} · agent: {conv.agent?.name ?? "auto"} ·{" "}
            {detail.messagingWindowOpen ? (
              <span className="text-[--color-ok]">24h window OPEN</span>
            ) : (
              <span className="text-[--color-warn]">24h window CLOSED — automated sends blocked (Meta policy)</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="flex items-center gap-1.5 text-[11px]">
            AI {conv.aiEnabled ? <Badge tone="ok">ON</Badge> : <Badge tone="danger">OFF</Badge>}
          </span>
          {conv.status === "HUMAN" || !conv.aiEnabled ? (
            <Button size="sm" variant="success" onClick={() => toggleAi(false)}>
              Return to AI
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => toggleAi(true)}>
              Take Over
            </Button>
          )}
          {process.env.NODE_ENV !== "production" && (
            <Button size="sm" variant="ghost" onClick={simulateInbound} disabled={simBusy} title="Dev simulator — feeds a message through the real webhook pipeline">
              Simulate inbound
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
        {conv.flowSessions.filter((s) => s.status === "ACTIVE").map((s) => (
          <div key={s.id} className="rounded border border-[--color-accent]/40 bg-[--color-accent]/10 px-2 py-1 text-center text-[11px]">
            Lead flow &ldquo;{s.flow.name}&rdquo; is running — the flow engine owns this conversation until finished.
          </div>
        ))}
        {conv.messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-[--color-border] p-3">
        <div className="flex gap-2">
          <Textarea
            rows={2}
            className="min-h-0"
            placeholder={detail.messagingWindowOpen ? "Reply as admin… (takes the conversation over)" : "Window closed — sending will fail unless the user writes again"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button onClick={send} disabled={busy || !text.trim()}>
            Send
          </Button>
        </div>
      </div>
    </>
  );
}

function MessageBubble({ m }: { m: MessageRow }) {
  const mine = m.direction === "OUT";
  const icon =
    m.sender === "AI" ? <Bot size={11} /> : m.sender === "ADMIN" ? <ShieldCheck size={11} /> : m.sender === "SYSTEM" ? <Cpu size={11} /> : <User size={11} />;
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[75%] rounded-lg px-3 py-2",
          mine ? "bg-[--color-accent]/15 border border-[--color-accent]/25" : "bg-[--color-panel-2] border border-[--color-border]",
        )}
      >
        <div className="mb-0.5 flex items-center gap-1.5 text-[10px] text-[--color-fg-faint]">
          {icon}
          {m.sender}
          <span>· {formatDate(m.createdAt)}</span>
          {m.aiLatencyMs != null && <span>· {(m.aiLatencyMs / 1000).toFixed(1)}s</span>}
        </div>
        <div className="whitespace-pre-wrap text-sm leading-5">{m.text ?? "[attachment]"}</div>
      </div>
    </div>
  );
}
