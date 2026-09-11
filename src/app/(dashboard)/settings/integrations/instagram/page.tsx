"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { InstagramConnectCard } from "@/components/instagram/connect-card";
import { formatDate, timeAgo } from "@/lib/utils";

/** Spec §3 — Instagram Integration control page with the capability matrix. */

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
  permissions: Array<{ permission: string; granted: boolean }>;
  capabilities: Array<{ key: string; label: string; available: boolean; reason?: string }>;
  counts: { conversations: number; leads: number; content: number; agents: number };
}

function CallbackNotices() {
  const params = useSearchParams();
  React.useEffect(() => {
    const connected = params.get("connected");
    const error = params.get("error");
    const warnings = params.get("warnings");
    if (connected) toast.success(`Connected ${connected} Instagram account(s)`);
    if (warnings) toast.warning("Connected with warnings", { description: warnings, duration: 9000 });
    if (error) {
      const map: Record<string, string> = {
        denied: "You cancelled the Meta authorization.",
        session_mismatch: "Session mismatch — log in and try again from this page.",
        missing_params: "Meta returned no authorization code.",
        connect_failed: params.get("detail") ?? "Connection failed — see server logs.",
        meta_error: "Meta reported an authorization error.",
        not_configured:
          "This installation has no Meta app credentials yet, so Instagram cannot be opened. Complete the one-time setup shown on this page.",
        instagram_app_missing:
          "Instagram sign-in needs its own app ID and secret (META_INSTAGRAM_APP_ID / META_INSTAGRAM_APP_SECRET) — the Facebook ones do not work here. See the setup note on this page.",
      };
      toast.error("Instagram connection failed", { description: map[error] ?? error, duration: 10000 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export default function InstagramIntegrationPage() {
  const [accounts, setAccounts] = React.useState<AccountRow[] | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const data = await api<{ accounts: AccountRow[] }>("/api/instagram/accounts", { silent: true });
    setAccounts(data.accounts);
  }, []);
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
        toast.success(`Connection OK — @${res.result.username ?? "?"}`, {
          description: res.result.followers != null ? `${res.result.followers} followers` : undefined,
        });
      } else if (action === "disconnect") {
        await api(`/api/instagram/accounts/${id}/disconnect`, { method: "POST" });
        toast.success("Account disconnected — tokens revoked locally");
      } else {
        const res = await api<{ synced: number }>(`/api/instagram/accounts/${id}/sync`, { method: "POST" });
        toast.success(`Synced ${res.synced} media items`);
      }
      await load();
    } catch {
      /* toast already shown by api() */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <React.Suspense>
        <CallbackNotices />
      </React.Suspense>

      <PageHeader
        title="Instagram Integration"
        description="Official Meta authorization only — no passwords, no scraping. There are two connection modes because Meta splits capabilities across products: Instagram Login covers messages, posts and insights; Facebook Login additionally unlocks paid ads and Instant Forms."
        accent="var(--color-mod-instagram)"
      />

      <InstagramConnectCard compact />

      {accounts === null && <p className="text-sm text-[--color-fg-muted]">Loading…</p>}
      {accounts?.length === 0 && (
        <Card>
          <CardBody className="py-10 text-center">
            <div className="text-sm">
              ○ Not connected — no Instagram accounts yet.
            </div>
            <p className="mx-auto mt-2 max-w-md text-xs text-[--color-fg-muted]">
              Eligibility: the Instagram account must be a <b>professional account</b> (Business or Creator).
              &ldquo;Connect with Facebook&rdquo; additionally requires the account to be linked to a Facebook Page and
              unlocks Campaigns / native ad CTAs / Instant Forms.
            </p>
          </CardBody>
        </Card>
      )}

      {accounts?.map((acc) => (
        <Card key={acc.id}>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                @{acc.username}
                {acc.isDemo && <Badge tone="warn">DEMO</Badge>}
                <Badge tone="default">{acc.connectionMode === "INSTAGRAM_LOGIN" ? "Instagram Login" : "Facebook Login"}</Badge>
              </span>
            }
            description={`${acc.name ?? ""} ${acc.accountType ? `· ${acc.accountType}` : ""} ${acc.fbPageName ? `· Page: ${acc.fbPageName}` : ""}`}
            actions={
              <>
                <StatusDot ok={acc.status === "CONNECTED"} warn={acc.status === "ERROR"} label={acc.status === "CONNECTED" ? "Connected" : acc.status} />
              </>
            }
          />
          <CardBody className="space-y-4">
            {/* identity + token block */}
            <div className="grid gap-x-8 gap-y-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
              <Info label="Instagram user ID" value={acc.igUserId} mono />
              <Info label="Followers" value={acc.followersCount?.toLocaleString() ?? "—"} />
              <Info label="Last synchronization" value={acc.lastSyncAt ? timeAgo(acc.lastSyncAt) : "never"} />
              <Info
                label="Token status"
                value={
                  <span className={acc.token.status === "ACTIVE" ? "text-[--color-ok]" : "text-[--color-danger]"}>
                    {acc.token.status}
                    {acc.token.expiresAt ? ` · expires ${formatDate(acc.token.expiresAt)}` : ""}
                  </span>
                }
              />
              <Info label="Token last refreshed" value={acc.token.lastRefreshAt ? timeAgo(acc.token.lastRefreshAt) : "—"} />
              <Info
                label="Webhook status"
                value={
                  acc.webhookSubscribed ? (
                    <span className="text-[--color-ok]">Subscribed</span>
                  ) : (
                    <span className="text-[--color-warn]">Not subscribed</span>
                  )
                }
              />
            </div>

            {/* capability / permission matrix — from real detection, never hardcoded */}
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[--color-fg-faint]">
                Capability matrix
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {acc.capabilities.map((cap) => (
                  <div
                    key={cap.key}
                    className="rounded-md border border-[--color-border] bg-[--color-panel-2] px-3 py-2"
                    title={cap.reason}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">{cap.label}</span>
                      {cap.available ? <Badge tone="ok">✓ Available</Badge> : <Badge tone="danger">Unavailable</Badge>}
                    </div>
                    {!cap.available && cap.reason && (
                      <p className="mt-1 text-[11px] leading-4 text-[--color-fg-muted]">{cap.reason}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* granted scopes */}
            <div>
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-[--color-fg-faint]">
                Granted permissions
              </div>
              <div className="flex flex-wrap gap-1.5">
                {acc.token.scopes.length === 0 && <span className="text-xs text-[--color-fg-muted]">none recorded</span>}
                {acc.token.scopes.map((s) => (
                  <Badge key={s} tone="accent" className="font-mono">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>

            {acc.connectionMode === "FACEBOOK_LOGIN" && <AdAccountPicker account={acc} onSaved={load} />}

            <div className="flex flex-wrap gap-2 border-t border-[--color-border] pt-3">
              <Button size="sm" variant="secondary" disabled={busy === `${acc.id}:test`} onClick={() => act(acc.id, "test")}>
                {busy === `${acc.id}:test` ? "Testing…" : "Test Connection"}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy === `${acc.id}:sync`} onClick={() => act(acc.id, "sync")}>
                {busy === `${acc.id}:sync` ? "Syncing…" : "Sync Content"}
              </Button>
              <Button asChild size="sm" variant="secondary">
                <a href={`/api/meta/oauth/start?mode=${acc.connectionMode === "FACEBOOK_LOGIN" ? "facebook" : "instagram"}`}>
                  Reconnect
                </a>
              </Button>
              <DisconnectButton
                username={acc.username}
                busy={busy === `${acc.id}:disconnect`}
                onConfirm={() => act(acc.id, "disconnect")}
              />
            </div>
          </CardBody>
        </Card>
      ))}

      <Card>
        <CardHeader title="Webhook endpoint" description="Configure this URL + verify token in the Meta App Dashboard (Webhooks → Instagram)" />
        <CardBody className="space-y-1 text-xs">
          <div className="font-mono text-[--color-fg-muted]">
            {typeof window !== "undefined" ? `${window.location.origin}/api/webhooks/instagram` : "/api/webhooks/instagram"}
          </div>
          <p className="text-[--color-fg-faint]">
            Verify token = META_WEBHOOK_VERIFY_TOKEN from .env. Meta requires public HTTPS and (for production
            traffic) the app switched to Live mode; in development use a tunnel (cloudflared/ngrok) and app-role test
            users. Signatures (X-Hub-Signature-256) are enforced.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function Info({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 sm:block">
      <span className="text-[--color-fg-faint]">{label}</span>
      <div className={mono ? "font-mono text-[--color-fg-muted]" : "text-[--color-fg]"}>{value}</div>
    </div>
  );
}

function DisconnectButton({ username, busy, onConfirm }: { username: string; busy: boolean; onConfirm: () => void }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" variant="danger" onClick={() => setOpen(true)} disabled={busy}>
        {busy ? "Disconnecting…" : "Disconnect"}
      </Button>
      <DialogContent
        title={`Disconnect @${username}?`}
        description="Local tokens are revoked and webhooks unsubscribed. Conversations, leads and content history stay in the database. You can reconnect at any time."
      >
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            Disconnect
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AdAccountPicker({ account, onSaved }: { account: AccountRow; onSaved: () => Promise<void> }) {
  const [options, setOptions] = React.useState<Array<{ id: string; name: string; currency?: string }> | null>(null);
  const [value, setValue] = React.useState(account.adAccountId ?? "");
  const [busy, setBusy] = React.useState(false);

  async function loadOptions() {
    try {
      const data = await api<{ adAccounts: Array<{ id: string; name: string; currency?: string }> }>(
        `/api/instagram/accounts/${account.id}/ad-accounts`,
      );
      setOptions(data.adAccounts);
    } catch {
      setOptions([]);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await api(`/api/instagram/accounts/${account.id}`, { method: "PATCH", json: { adAccountId: value || null } });
      toast.success("Ad account saved");
      await onSaved();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border border-[--color-border] bg-[--color-panel-2] p-3">
      <Field label="Ad account (required for Campaigns)" hint="Loaded from your Meta profile via /me/adaccounts.">
        <div className="flex gap-2">
          {options === null ? (
            <Button size="sm" variant="secondary" onClick={loadOptions}>
              Load ad accounts
            </Button>
          ) : (
            <>
              <Select value={value} onChange={(e) => setValue(e.target.value)} className="max-w-sm">
                <option value="">— none —</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({o.id}{o.currency ? `, ${o.currency}` : ""})
                  </option>
                ))}
                {account.adAccountId && !options.some((o) => o.id === account.adAccountId) && (
                  <option value={account.adAccountId}>{account.adAccountId} (current)</option>
                )}
              </Select>
              <Button size="sm" onClick={save} disabled={busy}>
                Save
              </Button>
            </>
          )}
        </div>
      </Field>
    </div>
  );
}
