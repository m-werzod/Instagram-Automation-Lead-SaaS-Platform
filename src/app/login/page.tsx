"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  ShieldCheck,
  User,
  Users,
  Workflow,
} from "lucide-react";
import { api } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { SetupRequired, type MissingCheck } from "@/components/setup-required";

/**
 * Sign-in page. Authentication uses a LOGIN (username), not an email address.
 * Split layout: product/brand panel + focused credential form. The brand panel
 * collapses into a compact header on small screens.
 */

interface SetupStatus {
  configured: boolean;
  missing: MissingCheck[];
  platform: string | null;
}

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();

  const [login, setLogin] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [capsLock, setCapsLock] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [setup, setSetup] = React.useState<SetupStatus | null>(null);

  const loginRef = React.useRef<HTMLInputElement>(null);

  // Check the installation is usable before offering a form that cannot work.
  React.useEffect(() => {
    let cancelled = false;
    fetch("/api/setup-status", { cache: "no-store" })
      .then((r) => r.json())
      .then((body: { data?: SetupStatus }) => {
        if (cancelled) return;
        const status = body.data ?? { configured: true, missing: [], platform: null };
        setSetup(status);
        if (status.configured) loginRef.current?.focus();
      })
      .catch(() => {
        if (!cancelled) setSetup({ configured: true, missing: [], platform: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const expired = params.get("expired") === "1";

  if (setup === null) {
    return <div className="h-[248px] animate-pulse rounded-md bg-[--color-panel-2]" aria-hidden />;
  }
  if (!setup.configured) {
    return <SetupRequired missing={setup.missing} platform={setup.platform} />;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/auth/login", {
        method: "POST",
        json: { login: login.trim(), password },
        silent: true,
      });
      const next = params.get("next");
      const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
      router.push(safeNext);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed. Please try again.");
      setPassword("");
      setBusy(false);
    }
  }

  function trackCapsLock(e: React.KeyboardEvent<HTMLInputElement>) {
    setCapsLock(e.getModifierState?.("CapsLock") ?? false);
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      {expired && !error && (
        <div className="flex items-start gap-2 rounded-md border border-[--color-warn]/35 bg-[--color-warn]/10 px-3 py-2 text-xs text-[--color-warn]">
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span>Your session expired. Please sign in again.</span>
        </div>
      )}

      <div>
        <label htmlFor="login" className="mb-1.5 block text-xs font-medium text-[--color-fg-muted]">
          Login
        </label>
        <div className="relative">
          <User
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[--color-fg-faint]"
            aria-hidden
          />
          <input
            id="login"
            ref={loginRef}
            name="login"
            type="text"
            inputMode="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="Your login"
            aria-invalid={Boolean(error)}
            className={cn(
              "h-11 w-full rounded-md border bg-[--color-panel-2] pl-9 pr-3 text-sm text-[--color-fg]",
              "placeholder:text-[--color-fg-faint] focus:outline-2 focus:outline-offset-0 focus:outline-[--color-accent]",
              "disabled:opacity-60 transition-colors",
              error ? "border-[--color-danger]/60" : "border-[--color-border-strong]",
            )}
            disabled={busy}
          />
        </div>
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-[--color-fg-muted]">
          Password
        </label>
        <div className="relative">
          <Lock
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[--color-fg-faint]"
            aria-hidden
          />
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyUp={trackCapsLock}
            onKeyDown={trackCapsLock}
            onBlur={() => setCapsLock(false)}
            placeholder="Your password"
            aria-invalid={Boolean(error)}
            className={cn(
              "h-11 w-full rounded-md border bg-[--color-panel-2] pl-9 pr-10 text-sm text-[--color-fg]",
              "placeholder:text-[--color-fg-faint] focus:outline-2 focus:outline-offset-0 focus:outline-[--color-accent]",
              "disabled:opacity-60 transition-colors",
              error ? "border-[--color-danger]/60" : "border-[--color-border-strong]",
            )}
            disabled={busy}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            title={showPassword ? "Hide password" : "Show password"}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-[--color-fg-faint] transition-colors hover:bg-[--color-panel] hover:text-[--color-fg]"
            tabIndex={-1}
          >
            {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        {capsLock && (
          <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-[--color-warn]">
            <AlertCircle size={12} /> Caps Lock is on
          </p>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-[--color-danger]/40 bg-[--color-danger]/10 px-3 py-2 text-xs text-[--color-danger]"
        >
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <button
        type="submit"
        disabled={busy || !login.trim() || !password}
        className={cn(
          "group flex h-11 w-full items-center justify-center gap-2 rounded-md text-sm font-semibold transition-colors",
          "bg-[--color-accent] text-white hover:bg-[--color-accent-hover]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[--color-accent]",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        {busy ? (
          <>
            <Loader2 size={15} className="animate-spin" />
            Signing in…
          </>
        ) : (
          <>
            Sign in
            <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
          </>
        )}
      </button>
    </form>
  );
}

const HIGHLIGHTS = [
  { icon: ShieldCheck, title: "Official Meta authorization", body: "OAuth only — no passwords, no scraping." },
  { icon: Bot, title: "AI agents with guardrails", body: "Scoped tools; never spends budget on its own." },
  { icon: Users, title: "Lead flows & CRM", body: "Sequential DM questions straight into your pipeline." },
  { icon: Workflow, title: "Full audit trail", body: "Every sensitive action recorded, with a master kill-switch." },
];

export default function LoginPage() {
  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      {/* ── Brand panel ─────────────────────────────────────────── */}
      <aside className="relative hidden overflow-hidden border-r border-[--color-border] bg-[--color-panel] lg:flex lg:flex-col lg:justify-between lg:p-12">
        {/* subtle technical grid, no gradients-as-decoration */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.35]"
          style={{
            backgroundImage:
              "linear-gradient(to right, var(--color-border) 1px, transparent 1px), linear-gradient(to bottom, var(--color-border) 1px, transparent 1px)",
            backgroundSize: "44px 44px",
            maskImage: "radial-gradient(ellipse at 30% 20%, black 30%, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse at 30% 20%, black 30%, transparent 75%)",
          }}
        />
        <div className="relative">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-[--color-accent] text-sm font-bold text-white">
              IG
            </div>
            <div>
              <div className="text-[15px] font-semibold leading-tight">Instagram Automation</div>
              <div className="text-xs text-[--color-fg-faint]">Control Center</div>
            </div>
          </div>

          <h1 className="mt-14 max-w-md text-3xl font-semibold leading-tight tracking-tight">
            Run your Instagram presence from one control center.
          </h1>
          <p className="mt-3 max-w-md text-sm leading-6 text-[--color-fg-muted]">
            Connect an eligible Instagram professional account through Meta, put AI agents on your DMs, capture
            qualified leads, and keep every automated action under explicit control.
          </p>

          <ul className="mt-10 max-w-md space-y-4">
            {HIGHLIGHTS.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex items-start gap-3">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md border border-[--color-border-strong] bg-[--color-panel-2] text-[--color-accent]">
                  <Icon size={15} />
                </span>
                <span>
                  <span className="block text-sm font-medium">{title}</span>
                  <span className="block text-xs leading-5 text-[--color-fg-muted]">{body}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-[11px] text-[--color-fg-faint]">
          Private internal platform · access limited to authorized administrators
        </p>
      </aside>

      {/* ── Sign-in panel ───────────────────────────────────────── */}
      <main className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-[380px]">
          {/* compact brand header on mobile */}
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <div className="grid h-9 w-9 place-items-center rounded-lg bg-[--color-accent] text-sm font-bold text-white">
              IG
            </div>
            <div>
              <div className="text-sm font-semibold leading-tight">Instagram Automation</div>
              <div className="text-[11px] text-[--color-fg-faint]">Control Center</div>
            </div>
          </div>

          <div className="mb-6">
            <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[--color-border-strong] bg-[--color-panel-2] text-[--color-accent]">
              <KeyRound size={16} />
            </div>
            <h2 className="text-xl font-semibold tracking-tight">Sign in</h2>
            <p className="mt-1 text-sm text-[--color-fg-muted]">
              Enter your administrator credentials to continue.
            </p>
          </div>

          <div className="rounded-xl border border-[--color-border] bg-[--color-panel] p-6 shadow-xl shadow-black/20">
            <React.Suspense
              fallback={<div className="h-[248px] animate-pulse rounded-md bg-[--color-panel-2]" aria-hidden />}
            >
              <SignInForm />
            </React.Suspense>
          </div>

          <div className="mt-5 flex items-start gap-2 text-[11px] leading-5 text-[--color-fg-faint]">
            <ShieldCheck size={13} className="mt-0.5 shrink-0" />
            <p>
              Authorized administrators only. Sessions expire after 7 days (24 h idle) and every sign-in attempt is
              audit-logged. Accounts lock for 5 minutes after 5 failed attempts.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
