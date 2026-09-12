import type { Metadata } from "next";
import { Instagram, ShieldCheck, CheckCircle2, AlertTriangle } from "lucide-react";
import { getDictionary } from "@/lib/i18n/server";
import { checkInviteToken } from "@/lib/meta/invites";
import { isInstagramLoginConfigured, isMetaConfigured } from "@/lib/env";
import { ConnectShell } from "../shell";

/**
 * PUBLIC invitation page — the Instagram account OWNER lands here.
 *
 * This person has no account on this platform, may never have heard of it, and
 * is about to be sent somewhere to type an Instagram password. That is exactly
 * what a phishing flow looks like, so the page's whole job is to make the ask
 * legible BEFORE the hand-off: who is asking, what is being requested, that the
 * password is typed on instagram.com and not here, and that access can be
 * withdrawn. The button is the last thing, not the first.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect Instagram",
  robots: { index: false, follow: false },
};

export default async function ConnectInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { d, locale } = await getDictionary();
  const c = d.connect;

  const check = await checkInviteToken(token);
  const configured = isMetaConfigured() && isInstagramLoginConfigured();

  if (!check.ok || !configured) {
    const reason = check.ok ? "not_configured" : check.reason;
    return (
      <ConnectShell>
        <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-(--color-warn-soft) text-(--color-warn)">
            <AlertTriangle size={26} />
          </span>
          <h1 className="text-lg font-bold">{c.invalidTitle}</h1>
          <p className="max-w-sm text-[13px] leading-6 text-(--color-fg-muted)">{c.reasons[reason]}</p>
          <p className="max-w-sm text-xs leading-5 text-(--color-fg-faint)">{c.askNew}</p>
        </div>
      </ConnectShell>
    );
  }

  const invite = check.invite;
  // uz has no wide ICU coverage in every runtime; en-GB is the closest
  // day-month-first format and never renders as a US date by accident.
  const expires = new Intl.DateTimeFormat(locale === "uz" ? "en-GB" : locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(invite.expiresAt);

  return (
    <ConnectShell>
      <div className="px-6 py-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="ig-gradient grid h-14 w-14 place-items-center rounded-2xl text-white shadow-lg">
            <Instagram size={26} />
          </span>
          <h1 className="text-lg font-bold leading-snug">{c.title}</h1>
          <p className="max-w-sm text-[13px] leading-6 text-(--color-fg-muted)">{c.intro}</p>
          {invite.label && (
            <p className="rounded-lg bg-(--color-panel-2) px-3 py-1.5 text-xs text-(--color-fg-muted)">
              {c.forLabel}: <span className="font-semibold text-(--color-fg)">{invite.label}</span>
            </p>
          )}
        </div>

        <section className="mt-7">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--color-fg-faint)">{c.stepsTitle}</h2>
          <ol className="space-y-2.5">
            {[c.s1, c.s2, c.s3, c.s4].map((step, i) => (
              <li key={i} className="flex gap-2.5">
                <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-(--color-accent-soft) text-[10px] font-bold text-(--color-accent)">
                  {i + 1}
                </span>
                <span className="text-[13px] leading-6 text-(--color-fg-muted)">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-(--color-fg-faint)">{c.permsTitle}</h2>
          <ul className="space-y-1.5">
            {[c.perm1, c.perm2, c.perm3].map((perm, i) => (
              <li key={i} className="flex items-start gap-2">
                <CheckCircle2 size={14} className="mt-1 shrink-0 text-(--color-ok)" />
                <span className="text-[13px] leading-6 text-(--color-fg-muted)">{perm}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 text-[11px] leading-5 text-(--color-fg-faint)">{c.needPro}</p>
        </section>

        {/* A plain <a>: this is a top-level navigation to our own server, which
            then redirects to instagram.com. No JS needed for it to work. */}
        <a
          href={`/api/connect/start?token=${encodeURIComponent(token)}`}
          className="ig-gradient mt-7 flex h-12 w-full items-center justify-center gap-2 rounded-xl text-[15px] font-semibold text-white shadow-sm transition-opacity hover:opacity-90"
        >
          <Instagram size={18} /> {c.continueBtn}
        </a>

        <div className="mt-4 flex items-start gap-2 rounded-xl bg-(--color-panel-2) p-3">
          <ShieldCheck size={15} className="mt-0.5 shrink-0 text-(--color-ok)" />
          <div className="min-w-0">
            <p className="text-[11px] leading-5 text-(--color-fg-muted)">{c.safety}</p>
            <p className="mt-1 text-[11px] leading-5 text-(--color-fg-faint)">{c.expiresOn(expires)}</p>
          </div>
        </div>
      </div>
    </ConnectShell>
  );
}
