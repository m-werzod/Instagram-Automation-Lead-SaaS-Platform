"use client";

import * as React from "react";
import { api } from "@/lib/client/api";
import { Card, CardBody } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";

interface LogRow {
  id: string;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  before: unknown;
  after: unknown;
  ip: string | null;
  success: boolean;
  error: string | null;
  createdAt: string;
  admin: { login: string; name: string } | null;
}

export default function AuditLogsPage() {
  const [logs, setLogs] = React.useState<LogRow[]>([]);
  const [cursor, setCursor] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState("");
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const load = React.useCallback(
    async (reset: boolean) => {
      const params = new URLSearchParams();
      if (filter) params.set("action", filter);
      if (!reset && cursor) params.set("cursor", cursor);
      const data = await api<{ logs: LogRow[]; nextCursor: string | null }>(`/api/audit-logs?${params}`, { silent: true });
      setLogs((prev) => (reset ? data.logs : [...prev, ...data.logs]));
      setCursor(data.nextCursor);
    },
    [filter, cursor],
  );

  React.useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Audit Logs</h1>
          <p className="text-xs text-[--color-fg-muted]">Every sensitive admin/AI action, immutable, with before/after snapshots.</p>
        </div>
        <Input placeholder="Filter by action (e.g. CAMPAIGN)" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-64" />
      </div>

      <Card>
        <CardBody className="p-0">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-[--color-border] text-[--color-fg-faint]">
              <tr>
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="px-4 py-2 font-medium">Admin</th>
                <th className="px-4 py-2 font-medium">Action</th>
                <th className="px-4 py-2 font-medium">Resource</th>
                <th className="px-4 py-2 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <React.Fragment key={l.id}>
                  <tr
                    className="cursor-pointer border-b border-[--color-border] last:border-0 hover:bg-[--color-panel-2]"
                    onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-[--color-fg-muted]">{formatDate(l.createdAt)}</td>
                    <td className="px-4 py-2">{l.admin?.login ?? "system"}</td>
                    <td className="px-4 py-2 font-mono text-[11px]">{l.action}</td>
                    <td className="px-4 py-2 text-[--color-fg-muted]">
                      {l.resourceType ?? ""} {l.resourceId ? `· ${l.resourceId.slice(0, 8)}…` : ""}
                    </td>
                    <td className="px-4 py-2">
                      {l.success ? <Badge tone="ok">OK</Badge> : <Badge tone="danger">FAILED</Badge>}
                    </td>
                  </tr>
                  {expanded === l.id && (
                    <tr className="border-b border-[--color-border] bg-[--color-panel-2]">
                      <td colSpan={5} className="px-4 py-2">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <JsonBlock label="Before" value={l.before} />
                          <JsonBlock label="After" value={l.after} />
                        </div>
                        {l.error && <p className="mt-1 text-[11px] text-[--color-danger]">{l.error}</p>}
                        {l.ip && <p className="mt-1 text-[10px] text-[--color-fg-faint]">IP: {l.ip}</p>}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-[--color-fg-muted]">
                    No audit entries match.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardBody>
      </Card>
      {cursor && (
        <div className="text-center">
          <Button variant="secondary" onClick={() => load(false)}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}

function JsonBlock({ label, value }: { label: string; value: unknown }) {
  if (value == null) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase text-[--color-fg-faint]">{label}</div>
      <pre className="overflow-x-auto rounded bg-[--color-bg] p-2 font-mono text-[10px] leading-4">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
