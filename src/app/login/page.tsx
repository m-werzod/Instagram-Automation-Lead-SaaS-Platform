"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Instagram, Eye, EyeOff, AlertCircle, ShieldCheck, CheckCircle2, Globe } from "lucide-react";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n/config";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { SetupRequired, type MissingCheck } from "@/components/setup-required";

/** Sign-in — bright, friendly, fully localized (Uzbek default). */

interface SetupStatus {
  configured: boolean;
  missing: MissingCheck[];
  platform?: string | null;
}

function LoginForm() {
  const { d } = useI18n();
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
    return <div className="h-[248px] animate-pulse rounded-xl bg-(--color-panel-2)" aria-hidden />;
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
      setError(err instanceof Error ? err.message : d.common.error);
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
        <div className="flex items-start gap-2 rounded-lg bg-(--color-warn-soft) px-3 py-2 text-xs text-(--color-warn)">
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span>{d.errors.sessionExpired}</span>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-(--color-danger-soft) px-3 py-2 text-xs text-(--color-danger)">
          <AlertCircle size={14} className="mt-px shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div>
        <label htmlFor="login" className="mb-1.5 block text-xs font-semibold text-(--color-fg-muted)">
          {d.auth.login}
        </label>
        <Input
          id="login"
          ref={loginRef}
          value={login}
          onChange={(e) => setLogin(e.target.value)}
          placeholder={d.auth.loginPlaceholder}
          autoComplete="username"
          className="h-11"
          required
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-xs font-semibold text-(--color-fg-muted)">
          {d.auth.password}
        </label>
        <div className="relative">
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={trackCapsLock}
            onKeyUp={trackCapsLock}
            placeholder={d.auth.passwordPlaceholder}
            autoComplete="current-password"
            className="h-11 pr-10"
            required
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute inset-y-0 right-0 grid w-10 place-items-center text-(--color-fg-faint) hover:text-(--color-fg)"
            aria-label={showPassword ? d.auth.hidePassword : d.auth.showPassword}
            tabIndex={-1}
          >
            {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        {capsLock && (
          <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-(--color-warn)">
            <AlertCircle size={12} /> {d.auth.capsLock}
          </p>
        )}
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy ? d.auth.signingIn : d.auth.signIn}
      </Button>

      <p className="flex items-center justify-center gap-1.5 text-[11px] text-(--color-fg-faint)">
        <ShieldCheck size={12} /> {d.auth.private}
      </p>
    </form>
  );
}

export default function LoginPage() {
  const { d, locale, setLocale } = useI18n();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-(--color-bg) p-4">
      {/* language switcher */}
      <div className="fixed right-4 top-4 flex items-center gap-1.5">
        <Globe size={14} className="text-(--color-fg-faint)" aria-hidden />
        <Select
          aria-label={d.common.language}
          className="h-8 w-32 text-xs"
          value={locale}
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_LABELS[l]}
            </option>
          ))}
        </Select>
      </div>

      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl border border-(--color-border) bg-white shadow-xl md:grid-cols-2">
        {/* brand panel */}
        <div className="ig-gradient relative hidden flex-col justify-between p-8 text-white md:flex">
          <div className="flex items-center gap-2.5">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-white/20 backdrop-blur">
              <Instagram size={20} />
            </span>
            <div>
              <div className="text-sm font-bold leading-tight">{d.shell.appName}</div>
              <div className="text-[11px] opacity-80">{d.shell.appTagline}</div>
            </div>
          </div>

          <div>
            <h1 className="text-2xl font-bold leading-snug">{d.auth.brandTitle}</h1>
            <ul className="mt-5 space-y-3">
              {d.auth.brandPoints.map((p) => (
                <li key={p} className="flex items-start gap-2.5 text-[13px] leading-5">
                  <CheckCircle2 size={16} className="mt-0.5 shrink-0 opacity-90" />
                  {p}
                </li>
              ))}
            </ul>
          </div>

          <div aria-hidden className="h-4" />
        </div>

        {/* form panel */}
        <div className="flex flex-col justify-center p-6 sm:p-10">
          <div className="mb-6 md:hidden">
            <span className="ig-gradient grid h-12 w-12 place-items-center rounded-xl text-white">
              <Instagram size={22} />
            </span>
          </div>
          <h2 className="text-xl font-bold">{d.auth.title}</h2>
          <p className="mb-6 mt-1 text-[13px] text-(--color-fg-muted)">{d.auth.subtitle}</p>
          <React.Suspense fallback={<div className="h-[248px] animate-pulse rounded-xl bg-(--color-panel-2)" aria-hidden />}>
            <LoginForm />
          </React.Suspense>
        </div>
      </div>
    </div>
  );
}
