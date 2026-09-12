"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Languages, Mail, Plus, ScrollText, Send, Settings2, Users } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n/config";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch, ToggleRow } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";

/**
 * Settings — three tabs driven by ?tab=: general switches (spec §16, §37),
 * administrators (spec §5) and the immutable audit trail.
 * Instagram connection management lives on /instagram, not here.
 */

const TABS = ["general", "admins", "audit"] as const;
type TabId = (typeof TABS)[number];

/** Spec §37 — the emergency stop must be typed, never mis-clicked. */
const CONFIRM_WORD = "STOP";

interface GlobalSettings {
  masterAutomationEnabled: boolean;
  autoCampaignLaunchEnabled: boolean;
  leadAutomationWhenOff: boolean;
}

interface AdminRow {
  id: string;
  login: string;
  email: string | null;
  name: string;
  role: "OWNER" | "ADMIN";
  isActive: boolean;
}

interface Me {
  id: string;
  role: string;
}

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

export default function SettingsPage() {
  const { d } = useI18n();
  return (
    <React.Suspense fallback={<div className="py-20 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</div>}>
      <SettingsInner />
    </React.Suspense>
  );
}

function SettingsInner() {
  const { d } = useI18n();
  const router = useRouter();
  const params = useSearchParams();

  const tabParam = params.get("tab");
  const tab: TabId = tabParam === "admins" || tabParam === "audit" ? tabParam : "general";

  const [settings, setSettings] = React.useState<GlobalSettings | null>(null);
  const [admins, setAdmins] = React.useState<AdminRow[]>([]);
  const [me, setMe] = React.useState<Me | null>(null);

  const load = React.useCallback(async () => {
    const [s, a, m] = await Promise.all([
      api<{ settings: GlobalSettings }>("/api/settings/global", { silent: true }),
      api<{ admins: AdminRow[] }>("/api/admin/admins", { silent: true }),
      api<{ admin: Me }>("/api/auth/me", { silent: true }),
    ]);
    setSettings(s.settings);
    setAdmins(a.admins);
    setMe(m.admin);
  }, []);

  React.useEffect(() => {
    void load().catch(() => undefined);
  }, [load]);

  function selectTab(t: TabId) {
    router.replace(t === "general" ? "/settings" : `/settings?tab=${t}`, { scroll: false });
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={d.settings.title} description={d.settings.subtitle} accent="var(--color-mod-system)" />

      <TabBar tab={tab} onSelect={selectTab} labels={d.settings.tabs} />

      {tab === "general" && <GeneralTab settings={settings} onSettings={setSettings} />}
      {tab === "admins" && <AdminsTab admins={admins} me={me} reload={load} />}
      {tab === "audit" && <AuditTab />}
    </div>
  );
}

/* ---------- tabs ---------- */

function TabBar({ tab, onSelect, labels }: { tab: TabId; onSelect: (t: TabId) => void; labels: Record<TabId, string> }) {
  const icons: Record<TabId, React.ReactNode> = {
    general: <Settings2 size={15} />,
    admins: <Users size={15} />,
    audit: <ScrollText size={15} />,
  };
  return (
    <div
      role="tablist"
      className="mb-5 flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg border border-(--color-border) bg-(--color-panel-2) p-1"
    >
      {TABS.map((t) => (
        <button
          key={t}
          role="tab"
          type="button"
          aria-selected={tab === t}
          onClick={() => onSelect(t)}
          className={cn(
            "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3.5 py-1.5 text-[13px] font-medium transition-colors",
            tab === t ? "bg-(--color-surface-raised) text-(--color-fg) shadow-sm" : "text-(--color-fg-muted) hover:text-(--color-fg)",
          )}
        >
          {icons[t]} {labels[t]}
        </button>
      ))}
    </div>
  );
}

/* ---------- GENERAL ---------- */

function GeneralTab({ settings, onSettings }: { settings: GlobalSettings | null; onSettings: (s: GlobalSettings) => void }) {
  const { d, locale, setLocale } = useI18n();
  const [confirmOff, setConfirmOff] = React.useState(false);
  const [stopWord, setStopWord] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [emailBusy, setEmailBusy] = React.useState(false);

  async function patchSettings(patch: Partial<GlobalSettings>) {
    const data = await api<{ settings: GlobalSettings }>("/api/settings/global", { method: "PATCH", json: patch });
    onSettings(data.settings);
    toast.success(d.common.saved);
  }
  const save = (patch: Partial<GlobalSettings>) => {
    void patchSettings(patch).catch(() => undefined);
  };

  function closeConfirm() {
    setConfirmOff(false);
    setStopWord("");
  }

  async function confirmMasterOff() {
    setBusy(true);
    try {
      await patchSettings({ masterAutomationEnabled: false });
      closeConfirm();
    } catch {
      /* error toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  async function testEmail() {
    setEmailBusy(true);
    try {
      await api<{ sent: boolean; to: string }>("/api/email/test", { method: "POST" });
      toast.success(d.settings.emailTestOk);
    } catch {
      /* error toast shown by api() */
    } finally {
      setEmailBusy(false);
    }
  }

  if (!settings) {
    return <p className="py-10 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>;
  }

  return (
    <div className="space-y-5">
      {/* interface language */}
      <Card>
        <CardHeader
          icon={<IconChip color="var(--color-accent)"><Languages size={16} /></IconChip>}
          title={d.settings.language}
          description={d.settings.languageHint}
        />
        <CardBody>
          <Select className="max-w-xs" value={locale} onChange={(e) => setLocale(e.target.value as Locale)} aria-label={d.settings.language}>
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {LOCALE_LABELS[l]}
              </option>
            ))}
          </Select>
        </CardBody>
      </Card>

      {/* Telegram — the PRIMARY lead receiver */}
      <TelegramCard />

      {/* master switch — spec §37 */}
      <Card className={settings.masterAutomationEnabled ? undefined : "border-(--color-danger)/50"}>
        <CardBody className="divide-y divide-(--color-border) py-1">
          <ToggleRow
            label={d.settings.master}
            description={d.settings.masterHint}
            checked={settings.masterAutomationEnabled}
            onCheckedChange={(v) => (v ? save({ masterAutomationEnabled: true }) : setConfirmOff(true))}
            danger={!settings.masterAutomationEnabled}
            onLabel={d.common.on}
            offLabel={d.common.off}
          />
          <ToggleRow
            label={d.settings.leadWhenOff}
            checked={settings.leadAutomationWhenOff}
            onCheckedChange={(v) => save({ leadAutomationWhenOff: v })}
            onLabel={d.common.on}
            offLabel={d.common.off}
          />
        </CardBody>
      </Card>

      {/* campaign money safety — spec §16 */}
      <Card>
        <CardBody className="py-1">
          <ToggleRow
            label={d.settings.autoCampaign}
            description={d.settings.autoCampaignHint}
            checked={settings.autoCampaignLaunchEnabled}
            onCheckedChange={(v) => save({ autoCampaignLaunchEnabled: v })}
            danger={settings.autoCampaignLaunchEnabled}
            onLabel={d.common.on}
            offLabel={d.common.off}
          />
        </CardBody>
      </Card>

      {/* email notifications */}
      <Card>
        <CardHeader
          icon={<IconChip color="var(--color-mod-leads)"><Mail size={16} /></IconChip>}
          title={d.settings.emailSection}
        />
        <CardBody>
          <Button variant="secondary" onClick={() => void testEmail()} disabled={emailBusy}>
            <Mail size={14} /> {d.settings.emailTest}
          </Button>
        </CardBody>
      </Card>

      {/* emergency-stop typed confirmation — spec §37 */}
      {confirmOff && (
        <Dialog open onOpenChange={(v) => !v && closeConfirm()}>
          <DialogContent title={d.settings.master} description={d.settings.masterOffConfirm}>
            <div className="space-y-3">
              <Input
                value={stopWord}
                onChange={(e) => setStopWord(e.target.value)}
                placeholder={CONFIRM_WORD}
                autoFocus
                autoCapitalize="characters"
                spellCheck={false}
              />
              <div className="flex justify-end gap-2">
                <Button variant="secondary" onClick={closeConfirm}>
                  {d.common.cancel}
                </Button>
                <Button
                  variant="danger"
                  disabled={busy || stopWord.trim().toUpperCase() !== CONFIRM_WORD}
                  onClick={() => void confirmMasterOff()}
                >
                  {d.common.off}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/* ---------- ADMINS ---------- */

interface TelegramStatus {
  configured: boolean;
  enabled: boolean;
  botUsername: string | null;
  chatId: string | null;
  source: "db" | "env" | null;
}

/** Telegram lead notifications — bot status, token entry, chat auto-detect, test. */
function TelegramCard() {
  const { d } = useI18n();
  const [status, setStatus] = React.useState<TelegramStatus | null>(null);
  const [tokenInput, setTokenInput] = React.useState("");
  const [busy, setBusy] = React.useState<"save" | "test" | null>(null);

  const load = React.useCallback(async () => {
    try {
      const data = await api<{ telegram: TelegramStatus }>("/api/settings/telegram", { silent: true });
      setStatus(data.telegram);
    } catch {
      /* leave null */
    }
  }, []);
  React.useEffect(() => {
    void load();
  }, [load]);

  async function saveToken() {
    if (!tokenInput.trim()) return;
    setBusy("save");
    try {
      const data = await api<{ telegram: TelegramStatus }>("/api/settings/telegram", {
        method: "PUT",
        json: { token: tokenInput.trim() },
      });
      setStatus(data.telegram);
      setTokenInput("");
      toast.success(d.settings.telegram.tokenSaved);
    } catch {
      /* toast from api() */
    } finally {
      setBusy(null);
    }
  }

  async function setEnabled(v: boolean) {
    const prev = status;
    setStatus((s) => (s ? { ...s, enabled: v } : s));
    try {
      await api("/api/settings/telegram", { method: "PUT", json: { enabled: v } });
      toast.success(d.common.saved);
    } catch {
      setStatus(prev);
    }
  }

  async function sendTest() {
    setBusy("test");
    try {
      await api<{ sent: boolean }>("/api/settings/telegram/test", { method: "POST" });
      toast.success(d.settings.telegram.testOk);
      await load();
    } catch {
      /* toast from api() */
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader
        icon={<IconChip color="#229ED9"><Send size={16} /></IconChip>}
        title={d.settings.telegram.title}
        description={d.settings.telegram.text}
        actions={
          status?.configured ? (
            <Badge tone={status.botUsername ? "ok" : "danger"}>
              {d.settings.telegram.bot}: {status.botUsername ? `@${status.botUsername}` : "?"}
            </Badge>
          ) : undefined
        }
      />
      <CardBody className="space-y-3">
        {status?.configured && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={status.chatId ? "ok" : "warn"}>
              {d.settings.telegram.chat}: {status.chatId ? d.settings.telegram.chatDetected : "—"}
            </Badge>
            {!status.chatId && <span className="text-(--color-fg-muted)">{d.settings.telegram.chatMissing}</span>}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <Field label={d.settings.telegram.token} className="min-w-0 flex-1 sm:max-w-md">
            <Input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={status?.configured ? "••••••••  (" + d.settings.telegram.tokenSaved + ")" : d.settings.telegram.tokenPh}
              autoComplete="off"
            />
          </Field>
          <Button variant="secondary" onClick={() => void saveToken()} disabled={busy !== null || !tokenInput.trim()}>
            {busy === "save" ? d.common.saving : d.common.save}
          </Button>
          <Button onClick={() => void sendTest()} disabled={busy !== null || !status?.configured}>
            <Send size={14} /> {busy === "test" ? d.common.loading : d.settings.telegram.test}
          </Button>
        </div>

        {status?.configured && (
          <div className="border-t border-(--color-border) pt-1">
            <ToggleRow
              label={d.settings.telegram.enabled}
              checked={status.enabled}
              onCheckedChange={(v) => void setEnabled(v)}
              onLabel={d.common.on}
              offLabel={d.common.off}
            />
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function AdminsTab({ admins, me, reload }: { admins: AdminRow[]; me: Me | null; reload: () => Promise<void> }) {
  const { d } = useI18n();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const isOwner = me?.role === "OWNER";

  async function setActive(a: AdminRow, v: boolean) {
    setBusyId(a.id);
    try {
      await api(`/api/admin/admins/${a.id}`, { method: "PATCH", json: { isActive: v } });
      toast.success(d.common.saved);
      await reload();
    } catch {
      /* error toast shown by api() */
    } finally {
      setBusyId(null);
    }
  }

  if (!me) {
    return <p className="py-10 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>;
  }

  return (
    <Card>
      <CardHeader
        icon={<IconChip color="var(--color-mod-system)"><Users size={16} /></IconChip>}
        title={d.settings.tabs.admins}
        actions={isOwner ? <CreateAdminDialog onCreated={reload} /> : undefined}
      />
      <CardBody className="space-y-2">
        {admins.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-(--color-border) px-3 py-2.5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {a.name}
                {a.id === me.id && <span className="font-normal text-(--color-fg-muted)">({d.settings.admins.you})</span>}
                <Badge tone={a.role === "OWNER" ? "accent" : "default"}>{a.role}</Badge>
                {!a.isActive && <Badge tone="danger">{d.common.disabled}</Badge>}
              </div>
              <div className="mt-0.5 text-[11px] text-(--color-fg-faint)">
                {d.settings.admins.login}: <span className="font-mono">{a.login}</span>
                {a.email ? ` · ${a.email}` : ""}
              </div>
            </div>
            {isOwner && a.id !== me.id && (
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-(--color-fg-muted)">{d.settings.admins.activeQ}</span>
                <Switch checked={a.isActive} disabled={busyId === a.id} onCheckedChange={(v) => void setActive(a, v)} />
              </div>
            )}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}

function CreateAdminDialog({ onCreated }: { onCreated: () => Promise<void> }) {
  const { d } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [login, setLogin] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<"ADMIN" | "OWNER">("ADMIN");
  const [busy, setBusy] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/admin/admins", { method: "POST", json: { login, email: email || undefined, name, password, role } });
      toast.success(d.common.saved);
      setOpen(false);
      setLogin("");
      setEmail("");
      setName("");
      setPassword("");
      setRole("ADMIN");
      await onCreated();
    } catch {
      /* error toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus size={14} /> {d.settings.admins.add}
      </Button>
      <DialogContent title={d.settings.admins.add}>
        <form onSubmit={submit} className="space-y-3">
          <Field label={d.settings.admins.login}>
            <Input value={login} onChange={(e) => setLogin(e.target.value)} required autoCapitalize="none" spellCheck={false} />
          </Field>
          <Field label={d.settings.admins.name}>
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label={`${d.leads.detail.email} (${d.common.optional.toLowerCase()})`}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={d.settings.admins.password}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Field label={d.settings.admins.role}>
            <Select value={role} onChange={(e) => setRole(e.target.value as "ADMIN" | "OWNER")}>
              <option value="ADMIN">ADMIN</option>
              <option value="OWNER">OWNER</option>
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {d.common.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? d.common.saving : d.common.create}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- AUDIT ---------- */

function AuditTab() {
  const { d } = useI18n();
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
    void load(true).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          icon={<IconChip color="var(--color-mod-system)"><ScrollText size={16} /></IconChip>}
          title={d.settings.tabs.audit}
          actions={
            <Input
              className="w-56"
              placeholder={d.settings.audit.action}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          }
        />
        <CardBody className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-(--color-border) text-(--color-fg-faint)">
                <tr>
                  <th className="px-4 py-2 font-medium">{d.settings.audit.when}</th>
                  <th className="px-4 py-2 font-medium">{d.settings.audit.admin}</th>
                  <th className="px-4 py-2 font-medium">{d.settings.audit.action}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <React.Fragment key={l.id}>
                    <tr
                      className="cursor-pointer border-b border-(--color-border) last:border-0 hover:bg-(--color-panel-2)"
                      onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                    >
                      <td className="whitespace-nowrap px-4 py-2 text-(--color-fg-muted)">{formatDate(l.createdAt)}</td>
                      <td className="px-4 py-2">{l.admin?.login ?? "system"}</td>
                      <td className="px-4 py-2">
                        <span className="font-mono text-[11px]">{l.action}</span>
                        {!l.success && (
                          <Badge tone="danger" className="ml-2">
                            FAILED
                          </Badge>
                        )}
                        {(l.resourceType || l.resourceId) && (
                          <span className="ml-2 text-[10px] text-(--color-fg-faint)">
                            {l.resourceType ?? ""}
                            {l.resourceId ? ` · ${l.resourceId.slice(0, 8)}…` : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                    {expanded === l.id && (
                      <tr className="border-b border-(--color-border) bg-(--color-panel-2)">
                        <td colSpan={3} className="px-4 py-2">
                          <div className="grid gap-2 sm:grid-cols-2">
                            <JsonBlock label="before" value={l.before} />
                            <JsonBlock label="after" value={l.after} />
                          </div>
                          {l.error && <p className="mt-1 text-[11px] text-(--color-danger)">{l.error}</p>}
                          {l.ip && <p className="mt-1 text-[10px] text-(--color-fg-faint)">IP: {l.ip}</p>}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-(--color-fg-muted)">
                      {d.settings.audit.empty}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardBody>
      </Card>
      {cursor && (
        <div className="text-center">
          <Button variant="secondary" onClick={() => void load(false).catch(() => undefined)}>
            {d.settings.audit.loadMore}
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
      <div className="mb-1 font-mono text-[10px] font-semibold uppercase text-(--color-fg-faint)">{label}</div>
      <pre className="overflow-x-auto rounded bg-(--color-bg) p-2 font-mono text-[10px] leading-4">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
