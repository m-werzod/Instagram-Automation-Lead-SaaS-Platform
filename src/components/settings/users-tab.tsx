"use client";

import * as React from "react";
import { toast } from "sonner";
import { Activity, Instagram, KeyRound, Plus, ShieldCheck, Trash2, UserCog, Users } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { useAccounts } from "@/components/shell/account-context";
import { Card, CardBody, CardHeader, IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";

/**
 * Users & access. Three roles — OWNER, ADMIN, USER — where a USER sees only the
 * Instagram accounts ticked for them. Every rule shown here is enforced again
 * on the server (src/lib/auth/access.ts, /api/admin/admins); the UI just
 * avoids offering actions that would be refused.
 */

export type Role = "OWNER" | "ADMIN" | "USER";

export interface AdminRow {
  id: string;
  login: string;
  email: string | null;
  name: string;
  role: Role;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  accounts: Array<{ id: string; username: string; status: string }>;
}

export interface Me {
  id: string;
  role: Role;
}

interface Detail {
  admin: AdminRow;
  accounts: Array<{ id: string; username: string; status: string; isDemo: boolean; adAccountId: string | null; grantedAt: string }>;
  stats: { leads: number; qualified: number; campaigns: number; activeCampaigns: number; agents: number; activeSessions: number };
  recentActivity: Array<{ id: string; action: string; resourceType: string | null; success: boolean; error: string | null; createdAt: string }>;
}

const ROLE_TONE: Record<Role, "accent" | "info" | "default"> = { OWNER: "accent", ADMIN: "info", USER: "default" };

/** Which roles the signed-in person may assign. */
function assignableRoles(me: Me): Role[] {
  return me.role === "OWNER" ? ["USER", "ADMIN", "OWNER"] : ["USER"];
}

function canManage(me: Me, target: AdminRow): boolean {
  if (target.id === me.id) return false;
  return me.role === "OWNER" || target.role === "USER";
}

export function UsersTab({ admins, me, reload }: { admins: AdminRow[]; me: Me | null; reload: () => Promise<void> }) {
  const { d } = useI18n();
  const t = d.settings.users;
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [manage, setManage] = React.useState<AdminRow | null>(null);
  const [detail, setDetail] = React.useState<AdminRow | null>(null);

  async function setActive(a: AdminRow, v: boolean) {
    setBusyId(a.id);
    try {
      await api(`/api/admin/admins/${a.id}`, { method: "PATCH", json: { isActive: v } });
      toast.success(v ? t.reactivated : t.suspendedOk);
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
        title={t.title}
        description={t.subtitle}
        actions={<CreateUserDialog me={me} onCreated={reload} />}
      />
      <CardBody className="space-y-2">
        {admins.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-(--color-border) px-3 py-2.5"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {a.name}
                {a.id === me.id && <span className="font-normal text-(--color-fg-muted)">({d.settings.admins.you})</span>}
                <Badge tone={ROLE_TONE[a.role]}>{t.roles[a.role]}</Badge>
                {!a.isActive && <Badge tone="danger">{t.suspended}</Badge>}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-(--color-fg-faint)">
                <span>
                  {d.settings.admins.login}: <span className="font-mono">{a.login}</span>
                </span>
                {a.email && <span>{a.email}</span>}
                <span>
                  {t.lastLogin}: {a.lastLoginAt ? formatDate(a.lastLoginAt) : t.never}
                </span>
              </div>
              {a.role === "USER" && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {a.accounts.length === 0 ? (
                    <span className="text-[11px] text-(--color-warn)">{t.noAccounts}</span>
                  ) : (
                    a.accounts.map((acc) => (
                      <span
                        key={acc.id}
                        className="inline-flex items-center gap-1 rounded-md bg-(--color-panel-2) px-1.5 py-0.5 text-[11px]"
                      >
                        <Instagram size={10} className="text-(--color-mod-instagram)" /> @{acc.username}
                      </span>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setDetail(a)}>
                <Activity size={13} /> {t.details}
              </Button>
              {canManage(me, a) && (
                <>
                  <Button size="sm" variant="secondary" onClick={() => setManage(a)}>
                    <UserCog size={13} /> {t.manage}
                  </Button>
                  <Button
                    size="sm"
                    variant={a.isActive ? "danger" : "success"}
                    disabled={busyId === a.id}
                    onClick={() => void setActive(a, !a.isActive)}
                  >
                    {a.isActive ? t.suspend : t.reactivate}
                  </Button>
                </>
              )}
            </div>
          </div>
        ))}
      </CardBody>

      {manage && (
        <ManageUserDialog
          me={me}
          user={manage}
          onClose={() => setManage(null)}
          onChanged={async () => {
            setManage(null);
            await reload();
          }}
        />
      )}
      {detail && <UserDetailDialog user={detail} onClose={() => setDetail(null)} />}
    </Card>
  );
}

/* ---------- account picker (shared by create + manage) ---------- */

function AccountPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const { d } = useI18n();
  const t = d.settings.users;
  const { accounts } = useAccounts();
  if (accounts.length === 0) {
    return <p className="text-[11px] text-(--color-warn)">{t.noAccountsToAssign}</p>;
  }
  return (
    <div className="grid gap-1.5 sm:grid-cols-2">
      {accounts.map((acc) => {
        const checked = value.includes(acc.id);
        return (
          <label
            key={acc.id}
            className={`flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-2 text-xs ${
              checked ? "border-(--color-accent) bg-(--color-accent-soft)" : "border-(--color-border)"
            }`}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => onChange(e.target.checked ? [...value, acc.id] : value.filter((id) => id !== acc.id))}
            />
            <Instagram size={12} className="shrink-0 text-(--color-mod-instagram)" />
            <span className="truncate font-medium">@{acc.username}</span>
            {acc.isDemo && <Badge>DEMO</Badge>}
          </label>
        );
      })}
    </div>
  );
}

/* ---------- create ---------- */

function CreateUserDialog({ me, onCreated }: { me: Me; onCreated: () => Promise<void> }) {
  const { d } = useI18n();
  const t = d.settings.users;
  const [open, setOpen] = React.useState(false);
  const [login, setLogin] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [name, setName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<Role>("USER");
  const [accountIds, setAccountIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);

  function reset() {
    setLogin("");
    setEmail("");
    setName("");
    setPassword("");
    setRole("USER");
    setAccountIds([]);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/api/admin/admins", {
        method: "POST",
        json: { login, email: email || undefined, name, password, role, accountIds: role === "USER" ? accountIds : [] },
      });
      toast.success(d.common.saved);
      setOpen(false);
      reset();
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
        <Plus size={14} /> {t.add}
      </Button>
      <DialogContent title={t.add}>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={d.settings.admins.login}>
              <Input value={login} onChange={(e) => setLogin(e.target.value)} required autoCapitalize="none" spellCheck={false} />
            </Field>
            <Field label={d.settings.admins.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} required />
            </Field>
          </div>
          <Field label={`${d.leads.detail.email} (${d.common.optional.toLowerCase()})`}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={d.settings.admins.password}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Field label={d.settings.admins.role} hint={t.roleHint[role]}>
            <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {assignableRoles(me).map((r) => (
                <option key={r} value={r}>
                  {t.roles[r]}
                </option>
              ))}
            </Select>
          </Field>
          {role === "USER" && (
            <Field label={t.accounts} hint={t.accountsHint}>
              <AccountPicker value={accountIds} onChange={setAccountIds} />
            </Field>
          )}
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

/* ---------- manage ---------- */

function ManageUserDialog({
  me,
  user,
  onClose,
  onChanged,
}: {
  me: Me;
  user: AdminRow;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { d } = useI18n();
  const t = d.settings.users;
  const [name, setName] = React.useState(user.name);
  const [email, setEmail] = React.useState(user.email ?? "");
  const [role, setRole] = React.useState<Role>(user.role);
  const [accountIds, setAccountIds] = React.useState<string[]>(user.accounts.map((a) => a.id));
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);

  const roles = assignableRoles(me);
  const roleLocked = !roles.includes(user.role); // an ADMIN looking at an OWNER/ADMIN record cannot get here, but keep it safe

  async function save() {
    setBusy(true);
    try {
      await api(`/api/admin/admins/${user.id}`, {
        method: "PATCH",
        json: {
          name,
          email: email || null,
          ...(roleLocked ? {} : { role }),
          ...(role === "USER" ? { accountIds } : {}),
          ...(password ? { password } : {}),
        },
      });
      toast.success(d.common.saved);
      await onChanged();
    } catch {
      /* error toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/api/admin/admins/${user.id}`, { method: "DELETE" });
      toast.success(t.removed);
      await onChanged();
    } catch {
      /* error toast shown by api() */
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={`${t.manage}: ${user.name}`} description={`${d.settings.admins.login}: ${user.login}`}>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={d.settings.admins.name}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label={d.leads.detail.email}>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          </div>
          <Field label={d.settings.admins.role} hint={roleLocked ? t.onlyOwner : t.roleHint[role]}>
            <Select value={role} disabled={roleLocked} onChange={(e) => setRole(e.target.value as Role)}>
              {(roleLocked ? [user.role] : roles).map((r) => (
                <option key={r} value={r}>
                  {t.roles[r]}
                </option>
              ))}
            </Select>
          </Field>
          {role === "USER" && (
            <Field label={t.accounts} hint={t.accountsHint}>
              <AccountPicker value={accountIds} onChange={setAccountIds} />
            </Field>
          )}
          <Field label={t.newPassword}>
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </Field>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-(--color-border) pt-3">
            {confirmRemove ? (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-(--color-danger)">{t.removeConfirm(user.name)}</span>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
                  <Trash2 size={13} /> {t.remove}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                  {d.common.cancel}
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="ghost" className="text-(--color-danger)" onClick={() => setConfirmRemove(true)}>
                <Trash2 size={13} /> {t.remove}
              </Button>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose}>
                {d.common.cancel}
              </Button>
              <Button disabled={busy} onClick={() => void save()}>
                {busy ? d.common.saving : d.common.save}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ---------- detail ---------- */

function UserDetailDialog({ user, onClose }: { user: AdminRow; onClose: () => void }) {
  const { d } = useI18n();
  const t = d.settings.users;
  const [detail, setDetail] = React.useState<Detail | null>(null);

  React.useEffect(() => {
    api<Detail>(`/api/admin/admins/${user.id}`, { silent: true })
      .then(setDetail)
      .catch(() => undefined);
  }, [user.id]);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent wide title={user.name} description={`${t.roles[user.role]} · ${d.settings.admins.login}: ${user.login}`}>
        {!detail ? (
          <p className="py-8 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</p>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label={t.stats.leads} value={detail.stats.leads} />
              <Stat label={t.stats.qualified} value={detail.stats.qualified} />
              <Stat label={t.stats.campaigns} value={detail.stats.campaigns} />
              <Stat label={t.stats.activeCampaigns} value={detail.stats.activeCampaigns} />
              <Stat label={t.stats.agents} value={detail.stats.agents} />
              <Stat label={t.stats.sessions} value={detail.stats.activeSessions} />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-(--color-fg-faint)">
                  <ShieldCheck size={13} /> {t.accounts}
                </h4>
                {user.role !== "USER" ? (
                  <p className="text-xs text-(--color-fg-muted)">{t.allAccounts}</p>
                ) : detail.accounts.length === 0 ? (
                  <p className="text-xs text-(--color-warn)">{t.noAccounts}</p>
                ) : (
                  <ul className="space-y-1">
                    {detail.accounts.map((a) => (
                      <li key={a.id} className="flex items-center gap-2 rounded-md bg-(--color-panel-2) px-2 py-1.5 text-xs">
                        <Instagram size={12} className="text-(--color-mod-instagram)" />
                        <span className="font-medium">@{a.username}</span>
                        <Badge tone={a.status === "CONNECTED" ? "ok" : "danger"}>{a.status}</Badge>
                        {a.adAccountId && <Badge tone="warn">ads</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 text-[11px] text-(--color-fg-faint)">
                  <KeyRound size={11} className="mr-1 inline" />
                  {t.lastLogin}: {detail.admin.lastLoginAt ? formatDate(detail.admin.lastLoginAt) : t.never} · {t.created}:{" "}
                  {formatDate(detail.admin.createdAt)}
                </p>
              </div>
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-(--color-fg-faint)">
                  <Activity size={13} /> {t.activity}
                </h4>
                {detail.recentActivity.length === 0 ? (
                  <p className="text-xs text-(--color-fg-muted)">{t.noActivity}</p>
                ) : (
                  <ul className="max-h-64 space-y-1 overflow-y-auto">
                    {detail.recentActivity.map((e) => (
                      <li key={e.id} className="flex items-center justify-between gap-2 rounded-md bg-(--color-panel-2) px-2 py-1.5 text-[11px]">
                        <span className="truncate font-mono">{e.action}</span>
                        {!e.success && <Badge tone="danger">FAILED</Badge>}
                        <span className="shrink-0 text-(--color-fg-faint)">{formatDate(e.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-(--color-panel-2) px-3 py-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-(--color-fg-faint)">{label}</div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
    </div>
  );
}
