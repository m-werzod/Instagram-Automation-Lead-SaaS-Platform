"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
  AlertTriangle,
  KeyRound,
  Settings2,
  X,
  UserPlus,
  Radio,
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
import { CopyField } from "@/components/ui/copy-field";
import { timeAgo } from "@/lib/utils";
import type { Dictionary } from "@/lib/i18n/dictionaries";

/**
 * Instagram — ONE place for everything about the connection:
 * connect / reconnect / disconnect, account health, what the connection can
 * do, and the advertising (Facebook) link-up. Official Meta OAuth only.
 *
 * Connecting is a three-party handshake (this app → Meta's app config →
 * instagram.com), and every way it fails is invisible from here. So the page
 * leads with the two things the admin cannot find out on their own: whether
 * this installation is even able to start an authorization, and — once they are
 * back from Instagram — what actually happened, in words, as a panel that stays
 * on screen rather than a toast that disappears while they are still reading.
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

interface ConfigStatus {
  configured: boolean;
  missing: string[];
  instagramLoginReady: boolean;
  instagramMissing: string[];
  appId: string | null;
  graphVersion: string;
  redirectUri: string;
  redirectUriIsHttps: boolean;
  redirectUriMatchesAppUrl: boolean;
  webhookUrl: string;
  verifyToken: string | null;
  appUrl: string;
  scopes: string[];
  optionalScopes: string[];
}

const CAP_LABEL: Record<string, (d: Dictionary) => string> = {
  messaging: (d) => d.instagram.capMessages,
  comments: (d) => d.instagram.capComments,
  publishing: (d) => d.instagram.capContent,
  insights: (d) => d.instagram.capInsights,
  ads: (d) => d.instagram.capAds,
};

const CAP_ORDER = ["messaging", "comments", "publishing", "insights", "ads"];

/** True when an authorization started from this app would actually reach Instagram. */
function canConnectInstagram(cfg: ConfigStatus | null): boolean {
  return Boolean(cfg?.configured && cfg.instagramLoginReady);
}

export default function InstagramPage() {
  const { d } = useI18n();
  const { reload: reloadContext } = useAccounts();
  const [accounts, setAccounts] = React.useState<AccountRow[] | null>(null);
  const [config, setConfig] = React.useState<ConfigStatus | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const loadConfig = React.useCallback(async () => {
    try {
      setConfig(await api<ConfigStatus>("/api/meta/config-status", { silent: true }));
    } catch {
      /* a failed probe must not hide the accounts below it */
    }
  }, []);

  const load = React.useCallback(async () => {
    const data = await api<{ accounts: AccountRow[] }>("/api/instagram/accounts", { silent: true });
    setAccounts(data.accounts);
    void reloadContext();
  }, [reloadContext]);

  React.useEffect(() => {
    void load();
    void loadConfig();
  }, [load, loadConfig]);

  async function act(id: string, action: "test" | "disconnect" | "sync" | "subscribe") {
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
      } else if (action === "subscribe") {
        await api(`/api/instagram/accounts/${id}/subscribe`, { method: "POST" });
        toast.success(d.instagram.webhookFixOk);
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

  const ready = canConnectInstagram(config);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader
        title={d.instagram.title}
        description={d.instagram.subtitle}
        accent="var(--color-mod-instagram)"
        actions={
          accounts && accounts.length > 0 && ready ? (
            <Button asChild variant="secondary" size="sm" title={d.instagram.switchHint}>
              {/* switch=1 → Instagram re-asks which account, instead of silently
                  re-approving the one already signed in in this browser. */}
              <a href="/api/meta/oauth/start?mode=instagram&switch=1">
                <UserPlus size={14} /> {d.instagram.switchAccount}
              </a>
            </Button>
          ) : undefined
        }
      />

      {/* what came back from Instagram — stays put until dismissed */}
      <React.Suspense>
        <ConnectOutcome />
      </React.Suspense>

      {/* can this installation authorize at all? */}
      {config && !ready && <SetupCard config={config} onRecheck={loadConfig} />}

      {accounts === null && <p className="py-10 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>}

      {/* not connected yet — the hero connect card */}
      {accounts?.length === 0 && <ConnectHero ready={ready} />}

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

              {/* Event delivery can fail on its own after a perfectly good
                  authorization, and without it nothing ever arrives — so it gets
                  its own retry instead of needing a full reconnect. */}
              {!acc.webhookSubscribed && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-(--color-warn)/35 bg-(--color-warn-soft) p-3.5">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <Radio size={16} className="mt-0.5 shrink-0 text-(--color-warn)" />
                    <p className="text-xs leading-5 text-(--color-fg)">{d.instagram.webhookFixHint}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy === `${acc.id}:subscribe`}
                    onClick={() => act(acc.id, "subscribe")}
                  >
                    {busy === `${acc.id}:subscribe` ? d.common.loading : d.instagram.webhookFix}
                  </Button>
                </div>
              )}

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
                        {/* account=… so the ad account lands on THIS profile and
                            not on every connected one. */}
                        <a href={`/api/meta/oauth/start?mode=facebook&account=${encodeURIComponent(acc.id)}`}>
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
                  <a
                    href={
                      acc.connectionMode === "FACEBOOK_LOGIN"
                        ? `/api/meta/oauth/start?mode=facebook&account=${encodeURIComponent(acc.id)}`
                        : "/api/meta/oauth/start?mode=instagram"
                    }
                  >
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

/* ---------- connecting ---------- */

/**
 * The first-connection card. It spells out the Instagram permission screen
 * BEFORE sending anyone there: being bounced to instagram.com and asked for a
 * password by a tool you just signed into looks like a phishing page unless you
 * were told to expect it.
 */
function ConnectHero({ ready }: { ready: boolean }) {
  const { d } = useI18n();
  return (
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
        {/* Never a dead link: until this installation can actually reach
            Instagram, the button is a disabled button, not an <a> that would
            bounce straight back with an error. */}
        {ready ? (
          <Button asChild variant="instagram" size="lg">
            <a href="/api/meta/oauth/start?mode=instagram">
              <Instagram size={18} /> {d.instagram.connectButton}
            </a>
          </Button>
        ) : (
          <Button variant="instagram" size="lg" disabled>
            <Instagram size={18} /> {d.instagram.connectButton}
          </Button>
        )}
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-(--color-fg-muted)">
          <span className="flex items-center gap-1.5"><MessagesSquare size={13} className="text-(--color-mod-content)" /> {d.instagram.capMessages}</span>
          <span className="flex items-center gap-1.5"><MessageSquareText size={13} className="text-(--color-mod-ai)" /> {d.instagram.capComments}</span>
          <span className="flex items-center gap-1.5"><Film size={13} className="text-(--color-mod-instagram)" /> {d.instagram.capContent}</span>
          <span className="flex items-center gap-1.5"><BarChart3 size={13} className="text-(--color-mod-overview)" /> {d.instagram.capInsights}</span>
        </div>
        <p className="flex items-center gap-1.5 text-[11px] text-(--color-fg-faint)">
          <ShieldCheck size={12} /> {d.auth.private}
        </p>

        <div className="mt-3 grid w-full gap-4 border-t border-(--color-border) pt-5 text-left sm:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--color-fg-faint)">
              {d.instagram.howTitle}
            </h3>
            <ol className="space-y-2">
              {[d.instagram.how1, d.instagram.how2, d.instagram.how3, d.instagram.how4].map((step, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-(--color-accent-soft) text-[10px] font-bold text-(--color-accent)">
                    {i + 1}
                  </span>
                  <span className="text-[12px] leading-5 text-(--color-fg-muted)">{step}</span>
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--color-fg-faint)">
              {d.instagram.needTitle}
            </h3>
            <ul className="space-y-2">
              {[d.instagram.need1, d.instagram.need2, d.instagram.need3].map((req, i) => (
                <li key={i} className="flex gap-2">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-(--color-ok)" />
                  <span className="text-[12px] leading-5 text-(--color-fg-muted)">{req}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Everything the Meta App Dashboard needs, and everything this installation is
 * missing, on one card. Shown only while connecting would fail — once it is
 * possible, it gets out of the way.
 */
function SetupCard({ config, onRecheck }: { config: ConfigStatus; onRecheck: () => Promise<void>; }) {
  const { d } = useI18n();
  const s = d.instagram.setup;
  const [busy, setBusy] = React.useState(false);
  const missing = [...config.missing, ...config.instagramMissing];
  const onVercel = config.appUrl.includes("vercel.app");

  async function recheck() {
    setBusy(true);
    try {
      await onRecheck();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-(--color-warn)/40">
      <CardHeader
        icon={<IconChip color="var(--color-warn)"><Settings2 size={16} /></IconChip>}
        title={s.title}
        description={s.text}
        actions={
          <Button size="sm" variant="secondary" onClick={() => void recheck()} disabled={busy}>
            <RefreshCcw size={13} /> {busy ? d.common.loading : s.recheck}
          </Button>
        }
      />
      <CardBody className="space-y-4">
        {/* the missing environment variables, in order, with what each one is */}
        <ol className="space-y-2">
          {missing.map((name, i) => (
            <li key={name} className="flex gap-2.5 rounded-lg border border-(--color-border) bg-(--color-panel-2) p-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-(--color-panel-3) text-[11px] font-semibold">
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <KeyRound size={13} className="shrink-0 text-(--color-fg-faint)" />
                  <code className="break-all font-mono text-xs font-semibold">{name}</code>
                </div>
                {s.vars[name] && <p className="mt-1 text-[11px] leading-5 text-(--color-fg-muted)">{s.vars[name]}</p>}
              </div>
            </li>
          ))}
        </ol>

        <p className="rounded-lg bg-(--color-accent-soft) px-3 py-2 text-[11px] leading-5 text-(--color-fg)">
          {onVercel ? s.envHintVercel : s.envHint}
        </p>

        {/* the values that have to be typed into Meta, not into .env */}
        <div className="space-y-3 border-t border-(--color-border) pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-(--color-fg-faint)">{s.pasteTitle}</h3>
          <CopyField label={s.redirectUri} value={config.redirectUri} hint={s.whereRedirect} />
          <CopyField label={s.webhookUrl} value={config.webhookUrl} hint={s.whereWebhook} />
          {config.verifyToken && <CopyField label={s.verifyToken} value={config.verifyToken} hint={s.whereWebhook} />}
        </div>

        {/* the two values that look right here but fail on Instagram's side */}
        {!config.redirectUriIsHttps && <Warn title={s.httpsTitle} text={s.httpsText} />}
        {!config.redirectUriMatchesAppUrl && (
          <Warn title={s.mismatchTitle} text={s.mismatchText(config.redirectUri, config.appUrl)} />
        )}

        {/* exactly what the dialog will request */}
        <div className="border-t border-(--color-border) pt-4">
          <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-(--color-fg-faint)">{s.permissions}</h3>
          <div className="flex flex-wrap gap-1.5">
            {config.scopes.map((scope) => (
              <code key={scope} className="rounded-md bg-(--color-panel-2) px-2 py-1 font-mono text-[11px]">
                {scope}
              </code>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-5 text-(--color-fg-muted)">{s.permissionsHint}</p>
          {config.optionalScopes.length > 0 && (
            <>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {config.optionalScopes.map((scope) => (
                  <code key={scope} className="rounded-md bg-(--color-panel-2) px-2 py-1 font-mono text-[11px] text-(--color-fg-faint)">
                    {scope}
                  </code>
                ))}
              </div>
              <p className="mt-2 text-[11px] leading-5 text-(--color-fg-faint)">{s.optionalHint}</p>
            </>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function Warn({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-(--color-warn)/35 bg-(--color-warn-soft) p-3">
      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-(--color-warn)" />
      <div className="min-w-0">
        <p className="text-xs font-semibold text-(--color-fg)">{title}</p>
        <p className="mt-0.5 text-[11px] leading-5 text-(--color-fg-muted)">{text}</p>
      </div>
    </div>
  );
}

/**
 * The result of a round trip to Meta, read off the callback's query string.
 *
 * A toast is the wrong shape for this: the admin has just come back from
 * another site, the message is often three sentences of what to fix, and it
 * arrives at the exact moment they are looking at the account list instead. So
 * failures render as a panel that stays until dismissed; only success is
 * transient, because success is self-evident from the card that appears.
 */
function ConnectOutcome() {
  const { d } = useI18n();
  const router = useRouter();
  const params = useSearchParams();

  const error = params.get("error");
  const detail = params.get("detail");
  const connected = params.get("connected");
  const warnings = params.get("warnings");

  // Success needs no lingering panel — the connected account card below IS the
  // confirmation. Warnings do linger: they describe something still broken.
  React.useEffect(() => {
    if (connected) toast.success(d.instagram.connectedN(Number(connected) || 1));
    // the parent already fetches the accounts on mount, which is this same page load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = () => router.replace("/instagram", { scroll: false });

  if (!error && !warnings) return null;

  return (
    <Card className={error ? "border-(--color-danger)/40" : "border-(--color-warn)/40"}>
      <CardBody className="flex items-start gap-3">
        {error ? (
          <XCircle size={18} className="mt-0.5 shrink-0 text-(--color-danger)" />
        ) : (
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-(--color-warn)" />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{error ? d.instagram.connectErrTitle : d.common.connected}</p>
          {error && (
            <p className="mt-1 text-[13px] leading-5 text-(--color-fg-muted)">
              {d.instagram.connectErrors[error] ?? d.instagram.connectErrors.connect_failed}
            </p>
          )}
          {warnings && <p className="mt-1 text-[13px] leading-5 text-(--color-fg-muted)">{warnings}</p>}
          {/* Meta's own words, kept verbatim and visually separate — it is the
              only clue when the failure is something we did not anticipate. */}
          {detail && (
            <p className="mt-2 rounded-lg bg-(--color-panel-2) px-2.5 py-1.5 font-mono text-[11px] leading-5 text-(--color-fg-faint)">
              {detail}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={d.common.close}
          title={d.common.close}
          className="shrink-0 cursor-pointer rounded-lg p-1 text-(--color-fg-muted) hover:bg-(--color-panel-2) hover:text-(--color-fg)"
        >
          <X size={16} />
        </button>
      </CardBody>
    </Card>
  );
}

/* ---------- account card pieces ---------- */

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
