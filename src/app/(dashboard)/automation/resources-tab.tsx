"use client";

import * as React from "react";
import { toast } from "sonner";
import { FileText, Image as ImageIcon, Upload, Video } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { formatDate } from "@/lib/utils";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/page-header";

/** Resources tab — files a rule can hand to people who comment on a post (see rules-tab's SEND_COMMENT_RESOURCE action). */

export interface ResourceRow {
  id: string;
  name: string;
  kind: "IMAGE" | "VIDEO" | "FILE";
  mimeType: string;
  sizeBytes: number;
  externalUrl: string | null;
  createdAt: string;
}

const KIND_ICON = { IMAGE: ImageIcon, VIDEO: Video, FILE: FileText } as const;

export function ResourcesTab({ accountId }: { accountId: string }) {
  const { d } = useI18n();
  const t = d.automation.resources;
  const [resources, setResources] = React.useState<ResourceRow[] | null>(null);
  const [file, setFile] = React.useState<File | null>(null);
  const [fileKey, setFileKey] = React.useState(0);
  const [name, setName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [deleteFor, setDeleteFor] = React.useState<ResourceRow | null>(null);
  const [deleteBusy, setDeleteBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const load = React.useCallback(async () => {
    const data = await api<{ resources: ResourceRow[] }>(`/api/comment-resources?accountId=${accountId}`, { silent: true });
    setResources(data.resources);
  }, [accountId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function upload(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("accountId", accountId);
      if (name) form.set("name", name);
      const res = await fetch("/api/comment-resources", { method: "POST", body: form, credentials: "same-origin" });
      const body = (await res.json()) as { ok: boolean; data?: { resource: ResourceRow }; error?: { message: string } };
      if (!res.ok || !body.ok || !body.data) {
        toast.error(body.error?.message ?? d.common.error);
        return;
      }
      toast.success(`“${body.data.resource.name}” — ${t.uploaded}`);
      setFile(null);
      setName("");
      setFileKey((k) => k + 1);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removeResource() {
    if (!deleteFor) return;
    setDeleteBusy(true);
    try {
      await api(`/api/comment-resources/${deleteFor.id}`, { method: "DELETE" });
      toast.success(d.common.done);
      setDeleteFor(null);
      await load();
    } finally {
      setDeleteBusy(false);
    }
  }

  if (resources === null) {
    return <p className="py-8 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>;
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader icon={<IconChip color="var(--color-mod-ai)"><Upload size={16} /></IconChip>} title={t.upload} description={t.uploadHint} />
        <CardBody>
          <form onSubmit={upload} className="grid gap-3 sm:grid-cols-2">
            <Field label={d.common.select}>
              <Input
                key={fileKey}
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.zip,.jpg,.jpeg,.png,.webp,.mp4,.mov"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="pt-1.5"
              />
            </Field>
            <Field label={`${t.name} (${d.common.optional.toLowerCase()})`}>
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder={file?.name} />
            </Field>
            <div className="flex items-end sm:col-span-2">
              <Button type="submit" disabled={!file || busy}>
                <Upload size={14} /> {busy ? t.uploading : t.upload}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      {resources.length === 0 ? (
        <EmptyState
          icon={<IconChip color="var(--color-mod-ai)" size={48}><FileText size={22} /></IconChip>}
          title={t.empty}
          action={
            <Button onClick={() => fileRef.current?.click()}>
              <Upload size={15} /> {t.upload}
            </Button>
          }
        />
      ) : (
        <Card>
          <CardHeader icon={<IconChip color="var(--color-mod-ai)"><FileText size={16} /></IconChip>} title={`${t.title} (${resources.length})`} />
          <CardBody className="overflow-x-auto p-0">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-(--color-border) text-(--color-fg-faint)">
                <tr>
                  <th className="px-4 py-2 font-medium">{t.name}</th>
                  <th className="px-4 py-2 font-medium">{d.common.status}</th>
                  <th className="px-4 py-2 font-medium">{d.leads.detail.created}</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {resources.map((r) => {
                  const Icon = KIND_ICON[r.kind];
                  return (
                    <tr key={r.id} className="border-b border-(--color-border) last:border-0">
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5 font-medium">
                          <Icon size={13} className="shrink-0 text-(--color-fg-faint)" /> {r.name}
                        </div>
                        <div className="text-[10px] text-(--color-fg-faint)">{Math.round(r.sizeBytes / 1024)} KB</div>
                      </td>
                      <td className="px-4 py-2">{t.kinds[r.kind]}</td>
                      <td className="px-4 py-2">{formatDate(r.createdAt)}</td>
                      <td className="px-4 py-2 text-right">
                        <Button size="sm" variant="ghost" className="hover:text-(--color-danger)" onClick={() => setDeleteFor(r)}>
                          {d.common.delete}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardBody>
        </Card>
      )}

      <Dialog open={deleteFor !== null} onOpenChange={(v) => !v && setDeleteFor(null)}>
        {deleteFor && (
          <DialogContent title={d.common.delete}>
            <p className="text-sm text-(--color-fg-muted)">{d.common.confirmDelete(deleteFor.name)}</p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDeleteFor(null)}>
                {d.common.cancel}
              </Button>
              <Button variant="danger" disabled={deleteBusy} onClick={removeResource}>
                {d.common.delete}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
