"use client";

import * as React from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleRow } from "@/components/ui/switch";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { InstagramConnectCard } from "@/components/instagram/connect-card";

/** Global switches (spec §16, §37), admin management (spec §5), email test. */

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

export default function SettingsPage() {
  const [settings, setSettings] = React.useState<GlobalSettings | null>(null);
  const [admins, setAdmins] = React.useState<AdminRow[]>([]);
  const [me, setMe] = React.useState<{ id: string; role: string } | null>(null);
  const [confirmMaster, setConfirmMaster] = React.useState<null | boolean>(null);
  const [emailBusy, setEmailBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    const [s, a, m] = await Promise.all([
      api<{ settings: GlobalSettings }>("/api/settings/global", { silent: true }),
      api<{ admins: AdminRow[] }>("/api/admin/admins", { silent: true }),
      api<{ admin: { id: string; role: string } }>("/api/auth/me", { silent: true }),
    ]);
    setSettings(s.settings);
    setAdmins(a.admins);
    setMe(m.admin);
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function patchSettings(patch: Partial<GlobalSettings>, message: string) {
    const data = await api<{ settings: GlobalSettings }>("/api/settings/global", { method: "PATCH", json: patch });
    setSettings(data.settings);
    toast.success(message);
  }

  async function testEmail() {
    setEmailBusy(true);
    try {
      const res = await api<{ sent: boolean; to: string }>("/api/email/test", { method: "POST" });
      toast.success(`Test email sent to ${res.to}`);
    } finally {
      setEmailBusy(false);
    }
  }

  if (!settings) return <p className="text-sm text-[--color-fg-muted]">Loading…</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Settings"
        description="Connect Instagram, control what the system is allowed to do automatically, and manage who can sign in."
        accent="var(--color-mod-system)"
      />

      {/* CONNECT INSTAGRAM — primary setup action */}
      <InstagramConnectCard />

      {/* MASTER SWITCH — spec §37 */}
      <Card className={settings.masterAutomationEnabled ? undefined : "border-[--color-danger]/50"}>
        <CardHeader
          title="Master Automation Switch"
          description="Emergency stop for the whole platform. When OFF, the AI stops replying, automations stop sending, and campaign automation halts — across every connected account."
        />
        <CardBody className="divide-y divide-[--color-border]">
          <ToggleRow
            label="Master automation"
            description={settings.masterAutomationEnabled ? "System is live — automated messaging is running." : "EVERYTHING automated is stopped."}
            checked={settings.masterAutomationEnabled}
            onCheckedChange={(v) => setConfirmMaster(v)}
            danger={!settings.masterAutomationEnabled}
          />
          <ToggleRow
            label="Keep lead capture during shutdown"
            description="When the master switch is OFF, in-flight lead flows and lead storage may still complete (no new AI replies)."
            checked={settings.leadAutomationWhenOff}
            onCheckedChange={(v) => patchSettings({ leadAutomationWhenOff: v }, "Saved")}
          />
        </CardBody>
      </Card>

      {/* campaign money safety — spec §16 */}
      <Card>
        <CardHeader
          title="Campaign spending safety"
          description="Publishing ANY campaign always requires typing its name in a confirmation dialog. This extra switch controls AI-drafted campaigns."
        />
        <CardBody>
          <ToggleRow
            label="Automatic Campaign Launch"
            description="OFF (default): campaigns drafted by the AI cannot be published at all — admins may only review them. ON: admins can publish AI drafts through the standard confirmation."
            checked={settings.autoCampaignLaunchEnabled}
            onCheckedChange={(v) =>
              patchSettings(
                { autoCampaignLaunchEnabled: v },
                v ? "AI-drafted campaigns can now be published (with confirmation)" : "AI-drafted campaigns locked",
              )
            }
            danger={settings.autoCampaignLaunchEnabled}
          />
        </CardBody>
      </Card>

      {/* email */}
      <Card>
        <CardHeader title="Email notifications" description="Lead notifications are sent to LEAD_NOTIFICATION_EMAIL (server-side .env). Delivery is queued with automatic retries." />
        <CardBody className="flex items-center gap-3">
          <Button variant="secondary" onClick={testEmail} disabled={emailBusy}>
            {emailBusy ? "Sending…" : "Send test email"}
          </Button>
          <span className="text-xs text-[--color-fg-muted]">Verifies SMTP credentials end-to-end.</span>
        </CardBody>
      </Card>

      {/* admins */}
      <Card>
        <CardHeader
          title="Administrators"
          description="Private platform — no public registration. Only OWNER can add or modify admins."
          actions={me?.role === "OWNER" ? <CreateAdminDialog onCreated={load} /> : undefined}
        />
        <CardBody className="space-y-2">
          {admins.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-md border border-[--color-border] px-3 py-2">
              <div>
                <div className="flex items-center gap-2 text-sm">
                  {a.name}
                  <Badge tone={a.role === "OWNER" ? "accent" : "default"}>{a.role}</Badge>
                  {!a.isActive && <Badge tone="danger">disabled</Badge>}
                </div>
                <div className="text-[11px] text-[--color-fg-faint]">
                Login: <span className="font-mono">{a.login}</span>
                {a.email ? ` · ${a.email}` : ""}
              </div>
              </div>
              {me?.role === "OWNER" && a.id !== me.id && (
                <Button
                  size="sm"
                  variant={a.isActive ? "danger" : "success"}
                  onClick={async () => {
                    await api(`/api/admin/admins/${a.id}`, { method: "PATCH", json: { isActive: !a.isActive } });
                    toast.success(a.isActive ? "Admin disabled (sessions revoked)" : "Admin re-enabled");
                    await load();
                  }}
                >
                  {a.isActive ? "Disable" : "Enable"}
                </Button>
              )}
            </div>
          ))}
        </CardBody>
      </Card>

      {/* master switch confirmation — spec §37 */}
      {confirmMaster !== null && (
        <Dialog open onOpenChange={(v) => !v && setConfirmMaster(null)}>
          <DialogContent
            title={confirmMaster ? "Enable all automation?" : "EMERGENCY STOP — disable all automation?"}
            description={
              confirmMaster
                ? "AI agents, automations and campaign tooling resume immediately."
                : "AI replies stop, outbound automations stop, campaign automation stops. Lead capture continues only if allowed below. In-Meta ACTIVE ad campaigns keep running — pause them in Campaigns if needed."
            }
          >
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmMaster(null)}>
                Cancel
              </Button>
              <Button
                variant={confirmMaster ? "success" : "danger"}
                onClick={async () => {
                  await patchSettings(
                    { masterAutomationEnabled: confirmMaster },
                    confirmMaster ? "Automation ENABLED" : "Automation DISABLED (emergency stop)",
                  );
                  setConfirmMaster(null);
                }}
              >
                {confirmMaster ? "Enable automation" : "Yes, stop everything"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function CreateAdminDialog({ onCreated }: { onCreated: () => Promise<void> }) {
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
      toast.success(`Admin "${login}" created`);
      setOpen(false);
      setLogin(""); setEmail(""); setName(""); setPassword("");
      await onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button size="sm" onClick={() => setOpen(true)}>
        Add admin
      </Button>
      <DialogContent
        title="Add administrator"
        description="Sign-in uses the Login (username). Password: 8+ chars with upper- and lower-case letters and a digit."
      >
        <form onSubmit={submit} className="space-y-3">
          <Field label="Login (username used to sign in)" hint="3–40 characters: letters, digits, dot, underscore or hyphen. Case-insensitive.">
            <Input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              required
              autoCapitalize="none"
              spellCheck={false}
              placeholder="operator1"
            />
          </Field>
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <Field label="Email (optional — for contact only, not sign-in)">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Password">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="ADMIN">ADMIN</option>
              <option value="OWNER">OWNER</option>
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
