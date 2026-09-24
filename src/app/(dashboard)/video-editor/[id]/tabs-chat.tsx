"use client";

import * as React from "react";
import { Send, Loader2, Check, X, AlertTriangle } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { ChatMessageRow, EditorState } from "./types";

/**
 * Natural-language editing.
 *
 * A proposal is shown as an explicit field-by-field diff and applied only when
 * the operator presses Apply. The assistant cannot change the project on its
 * own — it returns validated parameters, and this screen is the confirmation
 * step between those parameters and a render.
 */
export function ChatTab({ state, onReload }: { state: EditorState; onReload: () => Promise<void> }) {
  const { d } = useI18n();
  const t = d.videoEditor.chat;

  const [messages, setMessages] = React.useState<ChatMessageRow[]>(state.project.messages);
  const [input, setInput] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => setMessages(state.project.messages), [state.project.messages]);
  React.useEffect(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), [messages.length]);

  const disabled = !state.capabilities.chatAssistant.available;

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;
    setSending(true);
    setInput("");
    try {
      await api("/api/video/chat", { method: "POST", json: { projectId: state.project.id, message: text } });
      const fresh = await api<{ messages: ChatMessageRow[] }>(`/api/video/chat?projectId=${state.project.id}`, { silent: true });
      setMessages(fresh.messages);
    } catch {
      /* api() reported it */
    } finally {
      setSending(false);
    }
  }

  async function decide(messageId: string, accept: boolean) {
    try {
      await api("/api/video/chat", { method: "PATCH", json: { messageId, accept } });
      const fresh = await api<{ messages: ChatMessageRow[] }>(`/api/video/chat?projectId=${state.project.id}`, { silent: true });
      setMessages(fresh.messages);
      if (accept) await onReload();
    } catch {
      /* reported */
    }
  }

  return (
    <Card className="flex h-[620px] flex-col">
      <CardHeader title={t.title} />

      <div className="flex-1 space-y-3 overflow-y-auto px-4">
        {messages.length === 0 && <p className="py-8 text-center text-sm text-(--color-fg-muted)">{t.empty}</p>}

        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[85%] space-y-2 rounded-lg px-3 py-2 text-sm ${
                m.role === "user" ? "bg-(--color-accent-soft) text-(--color-fg)" : "border border-(--color-border) bg-(--color-panel-2)"
              }`}
            >
              <p className="whitespace-pre-wrap">{m.text}</p>

              {m.proposal && (
                <div className="space-y-2 rounded-md border border-(--color-border) bg-(--color-panel) p-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{t.proposed}</span>
                    {m.state === "APPLIED" && <Badge tone="ok">{t.applied}</Badge>}
                    {m.state === "REJECTED" && <Badge tone="default">{t.rejected}</Badge>}
                  </div>

                  {(m.proposal.changes ?? []).length > 0 && (
                    <ul className="space-y-0.5 text-xs text-(--color-fg-muted)">
                      {(m.proposal.changes ?? []).slice(0, 12).map((c) => (
                        <li key={c.path} className="font-mono">
                          {c.path}: {c.from} → {c.to}
                        </li>
                      ))}
                    </ul>
                  )}

                  {(m.proposal.unsupported ?? []).length > 0 && (
                    <div className="flex items-start gap-1.5 text-xs text-(--color-fg-muted)">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-warn)" />
                      <span>
                        {t.unsupported}: {(m.proposal.unsupported ?? []).join(", ")}
                      </span>
                    </div>
                  )}

                  {m.state === "PROPOSED" && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => void decide(m.id, true)}>
                        <Check className="mr-1.5 h-3.5 w-3.5" />
                        {t.apply}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void decide(m.id, false)}>
                        <X className="mr-1.5 h-3.5 w-3.5" />
                        {t.reject}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={send} className="flex gap-2 border-t border-(--color-border) p-3">
        <input
          className="flex-1 rounded-md border border-(--color-border) bg-(--color-panel-2) px-3 py-2 text-sm"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t.placeholder}
          disabled={disabled || sending}
          maxLength={2000}
        />
        <Button type="submit" disabled={disabled || sending || !input.trim()}>
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </form>

      {disabled && (
        <p className="px-3 pb-3 text-xs text-(--color-fg-muted)">
          {state.capabilities.chatAssistant.reason} {state.capabilities.chatAssistant.fix}
        </p>
      )}
    </Card>
  );
}
