"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Instagram,
  MessagesSquare,
  MessageSquareText,
  Film,
  BarChart3,
  Megaphone,
  RefreshCcw,
  Plug,
  CheckCircle2,
  XCircle,
  ShieldCheck,
} from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { useAccounts } from "@/components/shell/account-context";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { timeAgo } from "@/lib/utils";
import type { Dictionary } from "@/lib/i18n/dictionaries";

/**
 * Instagram — ONE place for everything about the connection:
 * connect / reconnect / disconnect, account health, what the connection can
 * do, and the advertising (Facebook) link-up. Official Meta OAuth only.
 */

interface AccountRow {
  id: string;
  igUserId: string;
  username: string;
  name: string | null;
  accountType: string | null;
  connectionMode: "INSTAGRAM_LOGIN" | "FACEBOOK_LOGIN";
  fbPageName: string | null;
  adAccountId: string | null;
  status: string;
  webhookSubscribed: boolean;
  lastSyncAt: string | null;
  isDemo: boolean;
  followersCount: number | null;
  token: { status: string; expiresAt: string | null; lastRefreshAt: string | null; scopes: string[] };
  capabilities: Array<{ key: string; label: string; available: boolean; reason?: string }>;
  counts: { conversations: number; leads: number; content: number; agents: number };
}

const CAP_LABEL: Record<string, (d: Dictionary) => string> = {
  messaging: (d) => d.instagram.capMessages,
  comments: (d) => d.instagram.capComments,
  publishing: (d) => d.instagram.capContent,
  insights: (d) => d.instagram.capInsights,
  ads: (d) => d.instagram.capAds,
};

const CAP_ORDER = ["messaging", "comments", "publishing", "insights", "ads"];

function CallbackNotices() {
  const { d } = useI18n();
  const params = useSearchParams();
  React.useEffect(() => {
    const connected = params.get("connected");
    const error = params.get("error");
    const warnings = params.get("warnings");
    if (connected) toast.success(`${d.common.connected}: ${connected}`);
    if (warnings) toast.warning(warnings, { duration: 9000 });
    if (error) {
      toast.error(d.instagram.status.ERROR, { description: params.get("detail") ?? error, duration: 10000 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export default function InstagramPage() {
  const { d } = useI18n();
  const { reload: reloadContext } = useAccounts();
  const [accounts, setAccounts] = React.useState<AccountRow[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const data = await api<{ accounts: AccountRow[] }>("/api/instagram/accounts", { silent: true });
    setAccounts(data.accounts);
    void reloadContext();
  }, [reloadContext]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function act(id: string, action: "test" | "disconnect" | "sync") {
    setBusy(`${id}:${action}`);
    try {
      if (action === "test") {
        const res = await api<{ result: { ok: boolean; username?: string; followers?: number | null } }>(
          `/api/instagram/accounts/${id}/test`,
          { method: "POST" },
        );
        toast.success(`${d.instagram.testOk} — @${res.result.username ?? "?"}`, {
          description: res.result.followers != null ? `${res.result.followers} ${d.instagram.followers}` : undefined,
        });
      } else if (action === "disconnect") {
        await api(`/api/instagram/accounts/${id}/disconnect`, { method: "POST" });
        toast.success(d.common.done);
      } else {
        const res = await api<{ synced: number }>(`/api/instagram/accounts/${id}/sync`, { method: "POST" });
        toast.success(d.content.syncedOk(res.synced));
      }
      await load();
    } catch {
      /* toast already shown by api() */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <React.Suspense>
        <CallbackNotices />
      </React.Suspense>

      <PageHeader
        title={d.instagram.title}
        description={d.instagram.subtitle}
        accent="var(--color-mod-instagram)"
        actions={
          accounts && accounts.length > 0 ? (
            <Button asChild variant="secondary" size="sm">
              <a href="/api/meta/oauth/start?mode=instagram">
                <Plug size={14} /> {d.instagram.connectAnother}
              </a>
            </Button>
          ) : undefined
        }
      />

      {accounts === null && <p className="py-10 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>}

      {/* not connected yet — the hero connect card */}
      {accounts?.length === 0 && (
        <Card className="overflow-hidden">
          <div className="ig-gradient h-1.5 w-full" />
          <CardBody className="flex flex-col items-center gap-4 py-10 text-center">
            <span className="ig-gradient grid h-16 w-16 place-items-center rounded-2xl text-white shadow-lg">
              <Instagram size={30} />
            </span>
            <div>
              <h2 className="text-lg font-bold">{d.instagram.connectTitle}</h2>
              <p className="mx-auto mt-1.5 max-w-md text-[13px] leading-5 text-(--color-fg-muted)">{d.instagram.connectText}</p>
            </div>
            <Button asChild variant="instagram" size="lg">
              <a href="/api/meta/oauth/start?mode=instagram">
                <Instagram size={18} /> {d.instagram.connectButton}
              </a>
            </Button>
            <div className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-(--color-fg-muted)">
              <span className="flex items-center gap-1.5"><MessagesSquare size={13} className="text-(--color-mod-content)" /> {d.instagram.capMessages}</span>
              <span className="flex items-center gap-1.5"><MessageSquareText size={13} className="text-(--color-mod-ai)" /> {d.instagram.capComments}</span>
              <span className="flex items-center gap-1.5"><Film size={13} className="text-(--color-mod-instagram)" /> {d.instagram.capContent}</span>
              <span className="flex items-center gap-1.5"><BarChart3 size={13} className="text-(--color-mod-overview)" /> {d.instagram.capInsights}</span>
            </div>
            <p className="flex items-center gap-1.5 text-[11px] text-(--color-fg-faint)">
              <ShieldCheck size={12} /> {d.auth.private}
            </p>
          </CardBody>
        </Card>
      )}

      {/* connected account cards */}
      {accounts?.map((acc) => {
        const caps = CAP_ORDER.map((k) => acc.capabilities.find((c) => c.key === k)).filter(Boolean) as AccountRow["capabilities"];
        return (
          <Card key={acc.id}>
            <CardHeader
              icon={
                <span className="ig-gradient grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold text-white">
                  {acc.username.charAt(0).toUpperCase()}
                </span>
              }
              title={
                <span className="flex flex-wrap items-center gap-2">
                  @{acc.username}
                  {acc.isDemo && <Badge tone="warn">{d.shell.demo.toUpperCase()}</Badge>}
                  <Badge tone={acc.status === "CONNECTED" ? "ok" : "danger"}>
                    {(d.instagram.status as Record<string, string>)[acc.status] ?? acc.status}
                  </Badge>
                </span>
              }
              description={
                <>
                  {acc.name ?? ""}
                  {acc.accountType ? ` · ${acc.accountType === "BUSINESS" ? d.instagram.business : d.instagram.creator}` : ""}
                  {acc.followersCount != null ? ` · ${acc.followersCount.toLocaleString()} ${d.instagram.followers}` : ""}
                </>
              }
            />
            <CardBody className="space-y-4">
              {/* quick facts */}
              <div className="grid gap-x-8 gap-y-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
                <Info label={d.instagram.lastSync} value={acc.lastSyncAt ? timeAgo(acc.lastSyncAt) : "—"} />
                <Info
                  label={d.instagram.webhooks}
                  value={
                    acc.webhookSubscribed ? (
                      <span className="text-(--color-ok)">{d.instagram.webhooksOn}</span>
                    ) : (
                      <span className="text-(--color-warn)">{d.instagram.webhooksOff}</span>
                    )
                  }
                />
                <Info
                  label="Token"
                  value={
                    <span className={acc.token.status === "ACTIVE" ? "text-(--color-ok)" : "text-(--color-danger)"}>
                      {acc.token.status}
                    </span>
                  }
                />
              </div>

              {/* what this connection can do */}
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--color-fg-faint)">
                  {d.instagram.capabilities}
                </div>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {caps.map((cap) => (
                    <div key={cap.key} className="flex items-center gap-2 rounded-lg bg-(--color-panel-2) px-3 py-2" title={cap.reason}>
                      {cap.available ? (
                        <CheckCircle2 size={15} className="shrink-0 text-(--color-ok)" />
                      ) : (
                        <XCircle size={15} className="shrink-0 text-(--color-fg-faint)" />
                      )}
                      <span className={cap.available ? "text-xs font-medium" : "text-xs text-(--color-fg-muted)"}>
                        {CAP_LABEL[cap.key]?.(d) ?? cap.label}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* advertising connection */}
              <div className="rounded-xl border border-(--color-border) bg-(--color-panel-2) p-3.5">
                <div className="mb-1 flex items-center gap-2">
                  <IconChip color="var(--color-mod-ads)" size={26}><Megaphone size={14} /></IconChip>
                  <span className="text-[13px] font-semibold">{d.instagram.adsSection}</span>
                  {acc.adAccountId ? <Badge tone="ok">{d.instagram.adsConnected}</Badge> : null}
                </div>
                {acc.adAccountId ? (
                  <AdAccountPicker d={d} account={acc} onSaved={load} />
                ) : (
                  <>
                    <p className="mb-2.5 text-xs leading-5 text-(--color-fg-muted)">{d.instagram.adsNotConnected}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button asChild size="sm" variant="secondary">
                        <a href="/api/meta/oauth/start?mode=facebook">
                          <Plug size={13} /> {d.instagram.connectAds}
                        </a>
                      </Button>
                      <AdAccountPicker d={d} account={acc} onSaved={load} lazy />
                    </div>
                  </>
                )}
              </div>

              {/* actions */}
              <div className="flex flex-wrap gap-2 border-t border-(--color-border) pt-3">
                <Button size="sm" variant="secondary" disabled={busy === `${acc.id}:test`} onClick={() => act(acc.id, "test")}>
                  {busy === `${acc.id}:test` ? d.common.loading : d.instagram.testConnection}
                </Button>
                <Button size="sm" variant="secondary" disabled={busy === `${acc.id}:sync`} onClick={() => act(acc.id, "sync")}>
                  <RefreshCcw size={13} />
                  {busy === `${acc.id}:sync` ? d.content.syncing : d.instagram.syncNow}
                </Button>
                <Button asChild size="sm" variant="secondary">
                  <a href={`/api/meta/oauth/start?mode=${acc.connectionMode === "FACEBOOK_LOGIN" ? "facebook" : "instagram"}`}>
                    {d.instagram.reconnect}
                  </a>
                </Button>
                <DisconnectButton
                  d={d}
                  username={acc.username}
                  busy={busy === `${acc.id}:disconnect`}
                  onConfirm={() => act(acc.id, "disconnect")}
                />
              </div>
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 sm:block">
      <span className="text-(--color-fg-faint)">{label}</span>
      <div className="text-(--color-fg)">{value}</div>
    </div>
  );
}

function DisconnectButton({
  d,
  username,
  busy,
  onConfirm,
}: {
  d: Dictionary;
  username: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)} disabled={busy}>
        {busy ? d.common.loading : d.instagram.disconnect}
      </Button>
      <DialogContent title={d.instagram.disconnectConfirm(username)}>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            {d.common.cancel}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {d.instagram.disconnect}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AdAccountPicker({
  d,
  account,
  onSaved,
  lazy,
}: {
  d: Dictionary;
  account: AccountRow;
  onSaved: () => Promise<void>;
  lazy?: boolean;
}) {
  const [options, setOptions] = React.useState<Array<{ id: string; name: string; currency?: string }> | null>(null);
  const [value, setValue] = React.useState(account.adAccountId ?? "");
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const loadOptions = React.useCallback(async () => {
    try {
      const data = await api<{ adAccounts: Array<{ id: string; name: string; currency?: string }> }>(
        `/api/instagram/accounts/${account.id}/ad-accounts`,
        { silent: lazy },
      );
      setOptions(data.adAccounts);
      setFailed(false);
    } catch {
      setOptions([]);
      setFailed(true);
    }
  }, [account.id, lazy]);

  React.useEffect(() => {
    if (!lazy) void loadOptions();
  }, [lazy, loadOptions]);

  async function save() {
    setBusy(true);
    try {
      await api(`/api/instagram/accounts/${account.id}`, { method: "PATCH", json: { adAccountId: value || null } });
      toast.success(d.common.saved);
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  if (lazy && options === null) return null;
  if (failed && lazy) return null;

  return (
    <Field label={d.instagram.chooseAdAccount}>
      <div className="flex flex-wrap gap-2">
        {options === null ? (
          <span className="text-xs text-(--color-fg-muted)">{d.common.loading}</span>
        ) : (
          <>
            <Select value={value} onChange={(e) => setValue(e.target.value)} className="max-w-sm">
              <option value="">— {d.common.none} —</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({o.id}
                  {o.currency ? `, ${o.currency}` : ""})
                </option>
              ))}
              {account.adAccountId && !options.some((o) => o.id === account.adAccountId) && (
                <option value={account.adAccountId}>{account.adAccountId}</option>
              )}
            </Select>
            <Button size="sm" onClick={save} disabled={busy}>
              {busy ? d.common.saving : d.common.save}
            </Button>
          </>
        )}
      </div>
    </Field>
  );
}
