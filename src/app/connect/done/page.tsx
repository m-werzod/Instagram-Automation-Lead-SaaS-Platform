import type { Metadata } from "next";
import { CheckCircle2, XCircle } from "lucide-react";
import { getDictionary } from "@/lib/i18n/server";
import { ConnectShell } from "../shell";

/**
 * Where the invited account owner lands after Instagram, success or not.
 *
 * Separate from the admin's /instagram page because this visitor has no session
 * and nothing to do next — the page's only job is to tell them, in their own
 * language, whether it worked and whether they need to act again.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Connect Instagram",
  robots: { index: false, follow: false },
};

export default async function ConnectDonePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { d } = await getDictionary();
  const c = d.connect;

  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const connected = one(params.connected);
  const username = one(params.username);
  const error = one(params.error);
  const warnings = one(params.warnings);

  const ok = Boolean(connected) && !error;

  return (
    <ConnectShell>
      <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
        <span
          className={`grid h-14 w-14 place-items-center rounded-2xl ${
            ok ? "bg-(--color-ok-soft) text-(--color-ok)" : "bg-(--color-danger-soft) text-(--color-danger)"
          }`}
        >
          {ok ? <CheckCircle2 size={28} /> : <XCircle size={28} />}
        </span>

        <h1 className="text-lg font-bold">{ok ? c.doneTitle : c.failTitle}</h1>

        <p className="max-w-sm text-[13px] leading-6 text-(--color-fg-muted)">
          {ok
            ? username
              ? c.doneText(username)
              : c.doneTextPlain
            : (c.reasons[error ?? "failed"] ?? c.reasons.failed)}
        </p>

        {/* Connected, but something secondary failed (usually the event
            subscription). The owner has done their part, so this is information,
            not an instruction. */}
        {ok && warnings && (
          <p className="max-w-sm rounded-lg bg-(--color-warn-soft) px-3 py-2 text-[11px] leading-5 text-(--color-fg-muted)">
            {warnings}
          </p>
        )}

        {!ok && <p className="max-w-sm text-xs leading-5 text-(--color-fg-faint)">{c.askNew}</p>}
      </div>
    </ConnectShell>
  );
}
