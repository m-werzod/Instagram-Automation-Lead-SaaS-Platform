"use client";

import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { useAccounts } from "@/components/shell/account-context";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Field, Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { formatDate } from "@/lib/utils";

/** Knowledge base (spec §26): upload → extract → chunk → embed → retrieve. */

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

export default function KnowledgePage() {
  const { selected } = useAccounts();
  const [docs, setDocs] = React.useState<DocRow[] | null>(null);
  const [retrievalMode, setRetrievalMode] = React.useState("");
  const [agents, setAgents] = React.useState<Array<{ id: string; name: string }>>([]);
  const [agentId, setAgentId] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    if (!selected) return;
    const data = await api<{ documents: DocRow[]; retrievalMode: string }>(`/api/knowledge?accountId=${selected.id}`, { silent: true });
    setDocs(data.documents);
    setRetrievalMode(data.retrievalMode);
    const ag = await api<{ agents: Array<{ id: string; name: string }> }>(`/api/agents?accountId=${selected.id}`, { silent: true });
    setAgents(ag.agents);
  }, [selected]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !selected) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("accountId", selected.id);
      if (agentId) form.set("agentId", agentId);
      if (title) form.set("title", title);
      const res = await fetch("/api/knowledge", { method: "POST", body: form, credentials: "same-origin" });
      const body = (await res.json()) as { ok: boolean; data?: { document: DocRow }; error?: { message: string; reason?: string } };
      if (!res.ok || !body.ok) {
        toast.error(body.error?.message ?? "Upload failed", { description: body.error?.reason });
        return;
      }
      const doc = body.data!.document;
      if (doc.status === "READY") toast.success(`"${doc.title}" processed — ${doc.chunkCount} chunks`);
      else toast.error(`"${doc.title}" failed: ${doc.error ?? "unknown error"}`);
      setFile(null);
      setTitle("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!selected) return <p className="text-sm text-[--color-fg-muted]">Connect an Instagram account first.</p>;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title="Knowledge"
        description={
          <>
            Upload your price lists, schedules and policies. This is the <b>only</b> place the AI is allowed to take
            facts from — it is instructed never to invent prices, addresses or availability. Documents belong to
            @{selected.username} alone. Search mode: <b>{retrievalMode || "…"}</b>.
          </>
        }
        accent="var(--color-mod-ai)"
      />

      <Card>
        <CardHeader title="Upload document" description="PDF, DOCX, TXT, Markdown — max 15 MB. Processed immediately: extract → chunk → embed (or keyword mode)." />
        <CardBody>
          <form onSubmit={upload} className="grid gap-3 sm:grid-cols-2">
            <Field label="File">
              <Input
                type="file"
                accept=".pdf,.docx,.txt,.md,.markdown"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="pt-1.5"
              />
            </Field>
            <Field label="Title (optional)">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pricing 2026" />
            </Field>
            <Field label="Restrict to agent (optional)">
              <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">— shared with all agents of this account —</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={!file || busy}>
                {busy ? "Processing…" : "Upload & process"}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Documents (${docs?.length ?? "…"})`} />
        <CardBody className="p-0">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[--color-border] text-[--color-fg-faint]">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Chunks</th>
                <th className="px-4 py-2 font-medium">Scope</th>
                <th className="px-4 py-2 font-medium">Uploaded</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {docs?.map((d) => (
                <tr key={d.id} className="border-b border-[--color-border] last:border-0">
                  <td className="px-4 py-2">
                    <div className="font-medium">{d.title}</div>
                    <div className="text-[10px] text-[--color-fg-faint]">
                      {d.filename} · {d.sizeBytes ? `${Math.round(d.sizeBytes / 1024)} KB` : ""}
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={d.status === "READY" ? "ok" : d.status === "ERROR" ? "danger" : "warn"}>{d.status}</Badge>
                    {d.error && <div className="mt-0.5 max-w-52 text-[10px] text-[--color-danger]">{d.error}</div>}
                  </td>
                  <td className="px-4 py-2">{d.chunkCount}</td>
                  <td className="px-4 py-2">{d.agent ? d.agent.name : "all agents"}</td>
                  <td className="px-4 py-2">{formatDate(d.createdAt)}</td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        if (!confirm(`Delete "${d.title}" and its chunks?`)) return;
                        await api(`/api/knowledge/${d.id}`, { method: "DELETE" });
                        toast.success("Document deleted");
                        await load();
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
              {docs?.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[--color-fg-muted]">
                    No documents yet. The AI can only state facts from Business Context or these documents.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}
