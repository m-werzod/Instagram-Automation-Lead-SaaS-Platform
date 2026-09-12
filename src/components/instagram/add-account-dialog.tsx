"use client";

import * as React from "react";
import { toast } from "sonner";
import { AlertTriangle, Info, Instagram, Link2, Plus, Send, UserPlus } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/input";
import { CopyField } from "@/components/ui/copy-field";
import { formatDate } from "@/lib/utils";

/**
 * Adding an account that is not already signed in on this machine.
 *
 * There are exactly two ways, because Instagram allows exactly two. Either the
 * admin is holding the account and authorizes it here, or the account belongs
 * to somebody else and that person has to approve it themselves — Instagram has
 * no API to request access to a handle, so a link they can open is the only
 * mechanism that exists. Both are offered side by side so the admin does not
 * have to know which one is "the real" one.
 */

interface InviteRow {
  id: string;
  label: string | null;
  createdAt: string;
  expiresAt: string;
  status: "PENDING" | "USED" | "EXPIRED" | "REVOKED";
  createdBy: string | null;
  account: { id: string; username: string } | null;
}

const TTL_CHOICES = [24, 72, 168] as const;

/**
 * A link built from APP_URL=localhost resolves to the recipient's OWN device,
 * where nothing is listening — so it silently opens nothing. That is invisible
 * from the admin's side, where the very same URL works perfectly.
 */
function isLocalOnly(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".local");
  } catch {
    return false;
  }
}

function Note({
  tone,
  icon,
  title,
  text,
}: {
  tone: "danger" | "info";
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  const skin =
    tone === "danger"
      ? "border-(--color-danger)/40 bg-(--color-danger-soft) text-(--color-danger)"
      : "border-(--color-info)/35 bg-(--color-info-soft) text-(--color-info)";
  return (
    <div className={`flex items-start gap-2.5 rounded-lg border p-3 ${skin}`}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-(--color-fg)">{title}</p>
        <p className="mt-0.5 text-[11px] leading-5 text-(--color-fg-muted)">{text}</p>
      </div>
    </div>
  );
}

export function AddAccountDialog({ onChanged }: { onChanged?: () => void | Promise<void> }) {
  const { d } = useI18n();
  const t = d.instagram.invites;

  const [open, setOpen] = React.useState(false);
  const [label, setLabel] = React.useState("");
  const [ttl, setTtl] = React.useState<number>(72);
  const [busy, setBusy] = React.useState(false);
  const [freshUrl, setFreshUrl] = React.useState<string | null>(null);
  const [invites, setInvites] = React.useState<InviteRow[] | null>(null);
  const [revoking, setRevoking] = React.useState<string | null>(null);
  /** Two-step revoke: a nested modal inside this one would be clumsy, and a
      native confirm() is the one dialog in the app that cannot be themed or
      translated. The button asks for itself instead. */
  const [confirming, setConfirming] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const data = await api<{ invites: InviteRow[] }>("/api/instagram/invites", { silent: true });
      setInvites(data.invites);
    } catch {
      setInvites([]);
    }
  }, []);

  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function create() {
    setBusy(true);
    try {
      const data = await api<{ url: string }>("/api/instagram/invites", {
        method: "POST",
        json: { label: label.trim() || undefined, ttlHours: ttl },
      });
      // Shown once and never recoverable — it is stored hashed.
      setFreshUrl(data.url);
      setLabel("");
      await load();
      await onChanged?.();
    } catch {
      /* toast from api() */
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setRevoking(id);
    try {
      await api(`/api/instagram/invites/${id}/revoke`, { method: "POST" });
      toast.success(t.statuses.REVOKED);
      setConfirming(null);
      await load();
    } catch {
      /* toast from api() */
    } finally {
      setRevoking(null);
    }
  }

  function close(next: boolean) {
    setOpen(next);
    if (!next) setFreshUrl(null);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <UserPlus size={14} /> {t.openBtn}
      </Button>

      <DialogContent title={t.dialogTitle} wide>
        <div className="space-y-4">
          {/* Option 1 — the account is right here */}
          <section className="rounded-xl border border-(--color-border) bg-(--color-panel-2) p-3.5">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold">
              <Instagram size={15} className="text-(--color-mod-instagram)" />
              {t.hereTitle}
            </h3>
            <p className="mt-1 text-xs leading-5 text-(--color-fg-muted)">{t.hereText}</p>
            <Button asChild size="sm" variant="instagram" className="mt-2.5">
              {/* switch=1 → force_reauth, so Instagram asks WHICH account instead
                  of silently re-approving whoever is already signed in here. */}
              <a href="/api/meta/oauth/start?mode=instagram&switch=1">
                <Instagram size={14} /> {t.hereBtn}
              </a>
            </Button>
          </section>

          {/* Option 2 — the account belongs to someone else */}
          <section className="rounded-xl border border-(--color-border) p-3.5">
            <h3 className="flex items-center gap-2 text-[13px] font-semibold">
              <Send size={15} className="text-(--color-accent)" />
              {t.linkTitle}
            </h3>
            <p className="mt-1 text-xs leading-5 text-(--color-fg-muted)">{t.linkText}</p>

            {freshUrl ? (
              <div className="mt-3 space-y-2.5">
                {/* Loudest thing on screen when the link cannot possibly work. */}
                {isLocalOnly(freshUrl) && (
                  <Note tone="danger" icon={<AlertTriangle size={15} />} title={t.localWarnTitle} text={t.localWarnText} />
                )}

                <div className="space-y-2 rounded-lg border border-(--color-ok)/35 bg-(--color-ok-soft) p-3">
                  <p className="text-xs font-semibold text-(--color-fg)">{t.createdTitle}</p>
                  <CopyField label={t.linkLabel} value={freshUrl} />
                  <CopyField label={t.copyMessage} value={t.shareTemplate(freshUrl)} />
                  <p className="text-[11px] leading-5 text-(--color-fg-muted)">{t.createdHint}</p>
                  <Button size="sm" variant="secondary" onClick={() => setFreshUrl(null)}>
                    <Plus size={13} /> {t.create}
                  </Button>
                </div>

                {/* The other way this looks "broken": waiting for something to
                    show up inside Instagram, which never happens by itself. */}
                <Note tone="info" icon={<Info size={15} />} title={t.mustOpenTitle} text={t.mustOpenText} />
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <Field label={t.label} hint={t.labelHint} className="min-w-0 flex-1">
                  <Input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder={t.labelPh}
                    autoCapitalize="none"
                    spellCheck={false}
                  />
                </Field>
                <Field label={t.expiry}>
                  <Select value={String(ttl)} onChange={(e) => setTtl(Number(e.target.value))} className="w-32">
                    {TTL_CHOICES.map((h) => (
                      <option key={h} value={h}>
                        {t.hours(h)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button onClick={() => void create()} disabled={busy}>
                  <Link2 size={14} /> {busy ? d.common.saving : t.create}
                </Button>
              </div>
            )}
          </section>

          {/* What has already been sent */}
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-(--color-fg-faint)">{t.pending}</h3>
            {invites === null ? (
              <p className="text-xs text-(--color-fg-muted)">{d.common.loading}</p>
            ) : invites.length === 0 ? (
              <p className="text-xs text-(--color-fg-muted)">{t.none}</p>
            ) : (
              <ul className="space-y-1.5">
                {invites.map((inv) => (
                  <li
                    key={inv.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-(--color-border) px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-[13px]">
                        <span className="font-medium">{inv.label ?? "—"}</span>
                        <Badge
                          tone={
                            inv.status === "USED" ? "ok" : inv.status === "PENDING" ? "accent" : "default"
                          }
                        >
                          {t.statuses[inv.status] ?? inv.status}
                        </Badge>
                        {inv.account && <span className="text-xs text-(--color-ok)">@{inv.account.username}</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-(--color-fg-faint)">
                        {t.expiresAt}: {formatDate(inv.expiresAt)}
                        {inv.createdBy ? ` · ${t.createdBy}: ${inv.createdBy}` : ""}
                      </div>
                    </div>
                    {inv.status === "PENDING" &&
                      (confirming === inv.id ? (
                        <div className="flex shrink-0 items-center gap-1.5">
                          <span className="text-[11px] text-(--color-fg-muted)">{t.revokeConfirm}</span>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={revoking === inv.id}
                            onClick={() => void revoke(inv.id)}
                          >
                            {revoking === inv.id ? d.common.loading : d.common.yes}
                          </Button>
                          <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>
                            {d.common.cancel}
                          </Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="danger" onClick={() => setConfirming(inv.id)}>
                          {t.revoke}
                        </Button>
                      ))}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
