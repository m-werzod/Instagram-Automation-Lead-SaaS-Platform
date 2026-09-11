"use client";

import * as React from "react";
import { toast } from "sonner";
import { BookOpen, Upload } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { formatDate } from "@/lib/utils";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/page-header";
import type { Dictionary } from "@/lib/i18n/dictionaries";

/** Knowledge tab — upload → extract → chunk → embed → retrieve (spec §26). */

interface DocRow {
  id: string;
  title: string;
  filename: string | null;
  status: "PENDING" | "PROCESSING" | "READY" | "ERROR";
  error: string | null;
  chunkCount: number;
  sizeBytes: number | null;
  embeddingProvider: string | null;
  createdAt: string;
  agent: { id: string; name: string } | null;
}

function statusLabel(d: Dictionary, status: DocRow["status"]): string {
  if (status === "READY") return d.automation.knowledge.statusReady;
  if (status === "ERROR") return d.automation.knowledge.statusError;
  return d.automation.knowledge.statusProcessing;
}

export function KnowledgeTab({ accountId }: { accountId: string }) {
  const { d } = useI18n();
  const [docs, setDocs] = React.useState<DocRow[] | null>(null);
  const [retrievalMode, setRetrievalMode] = React.useState("");
  const [agents, setAgents] = React.useState<Array<{ id: string; name: string }>>([]);
  const [agentId, setAgentId] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [fileKey, setFileKey] = React.useState(0);
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [deleteFor, setDeleteFor] = React.useState<DocRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    const data = await api<{ documents: DocRow[]; retrievalMode: string }>(`/api/knowledge?accountId=${accountId}`, {
      silent: true,
    });
    setDocs(data.documents);
    setRetrievalMode(data.retrievalMode);
    const ag = await api<{ agents: Array<{ id: string; name: string }> }>(`/api/agents?accountId=${accountId}`, {
      silent: true,
    });
    setAgents(ag.agents);
  }, [accountId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Multipart upload stays a raw fetch — the api() helper is JSON-only.
  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("accountId", accountId);
      if (agentId) form.set("agentId", agentId);
      if (title) form.set("title", title);
      const res = await fetch("/api/knowledge", { method: "POST", body: form, credentials: "same-origin" });
      const body = (await res.json()) as {
        ok: boolean;
        data?: { document: DocRow };
        error?: { message: string; reason?: string };
      };
      const doc = body.data?.document;
      if (!res.ok || !body.ok || !doc) {
        toast.error(body.error?.message ?? d.common.error, { description: body.error?.reason });
        return;
      }
      if (doc.status === "READY") {
        toast.success(`“${doc.title}” — ${d.automation.knowledge.chunks(doc.chunkCount)}`);
      } else {
        toast.error(`“${doc.title}”: ${doc.error ?? d.automation.knowledge.statusError}`);
      }
      setFile(null);
      setTitle("");
      setFileKey((k) => k + 1); // clears the native file input
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeDoc() {
    if (!deleteFor) return;
    setDeleteBusy(true);
    try {
      await api(`/api/knowledge/${deleteFor.id}`, { method: "DELETE" });
      toast.success(d.common.done);
      setDeleteFor(null);
      await load();
    } finally {
      setDeleteBusy(false);
    }
  }

  if (docs === null) {
    return <p className="py-8 text-center text-sm text-[--color-fg-muted]">{d.common.loading}</p>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={
            <IconChip color="var(--color-mod-ai)">
              <Upload size={16} />
            </IconChip>
          }
          title={d.automation.knowledge.upload}
        />
        <CardBody>
          <form onSubmit={upload} className="grid gap-3 sm:grid-cols-2">
            <Field label={d.common.select}>
              <Input
                key={fileKey}
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.txt,.md,.markdown"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="pt-1.5"
              />
            </Field>
            <Field label={`${d.automation.knowledge.docTitle} (${d.common.optional.toLowerCase()})`}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
            </Field>
            <Field label={d.automation.knowledge.forAgent}>
              <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">{d.automation.knowledge.allAgents}</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={!file || busy}>
                <Upload size={14} /> {busy ? d.automation.knowledge.uploading : d.automation.knowledge.upload}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {docs.length === 0 ? (
        <EmptyState
          icon={
            <IconChip color="var(--color-mod-ai)" size={48}>
              <BookOpen size={22} />
            </IconChip>
          }
          title={d.automation.knowledge.empty}
          action={
            <Button onClick={() => fileRef.current?.click()}>
              <Upload size={15} /> {d.automation.knowledge.upload}
            </Button>
          }
        />
      ) : (
        <Card>
          <CardHeader
            icon={
              <IconChip color="var(--color-mod-ai)">
                <BookOpen size={16} />
              </IconChip>
            }
            title={`${d.automation.tabs.knowledge} (${docs.length})`}
            actions={retrievalMode ? <Badge>{retrievalMode}</Badge> : undefined}
          />
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-[--color-border] text-[--color-fg-faint]">
                <tr>
                  <th className="px-4 py-2 font-medium">{d.automation.knowledge.docTitle}</th>
                  <th className="px-4 py-2 font-medium">{d.common.status}</th>
                  <th className="px-4 py-2 font-medium">{d.automation.knowledge.forAgent}</th>
                  <th className="px-4 py-2 font-medium">{d.leads.detail.created}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {docs.map((doc) => (
                  <tr key={doc.id} className="border-b border-[--color-border] last:border-0">
                    <td className="px-4 py-2">
                      <div className="font-medium">{doc.title}</div>
                      <div className="text-[10px] text-[--color-fg-faint]">
                        {doc.filename}
                        {doc.sizeBytes ? ` · ${Math.round(doc.sizeBytes / 1024)} KB` : ""}
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={doc.status === "READY" ? "ok" : doc.status === "ERROR" ? "danger" : "warn"}>
                          {statusLabel(d, doc.status)}
                        </Badge>
                        <span className="text-[--color-fg-faint]">{d.automation.knowledge.chunks(doc.chunkCount)}</span>
                      </div>
                      {doc.error && <div className="mt-0.5 max-w-52 text-[10px] text-[--color-danger]">{doc.error}</div>}
                    </td>
                    <td className="px-4 py-2">{doc.agent ? doc.agent.name : d.automation.knowledge.allAgents}</td>
                    <td className="px-4 py-2">{formatDate(doc.createdAt)}</td>
                    <td className="px-4 py-2 text-right">
                      <Button size="sm" variant="ghost" className="hover:text-[--color-danger]" onClick={() => setDeleteFor(doc)}>
                        {d.common.delete}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      <Dialog open={deleteFor !== null} onOpenChange={(v) => !v && setDeleteFor(null)}>
        {deleteFor && (
          <DialogContent title={d.common.delete}>
            <p className="text-sm text-[--color-fg-muted]">{d.common.confirmDelete(deleteFor.title)}</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDeleteFor(null)}>
                {d.common.cancel}
              </Button>
              <Button variant="danger" disabled={deleteBusy} onClick={removeDoc}>
                {d.common.delete}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
