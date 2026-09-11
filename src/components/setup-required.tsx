"use client";

import * as React from "react";
import { AlertTriangle, Database, KeyRound, Link2, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";

/**
 * Shown instead of the sign-in form when the installation has no working
 * configuration. Without this the failure surfaces inside the password field's
 * error slot, which reads like "wrong password" and sends people hunting for
 * the wrong problem.
 */

export interface MissingCheck {
  name: string;
  problem?: string;
}

const ICONS: Record<string, typeof Database> = {
  APP_URL: Link2,
  DATABASE_URL: Database,
  SESSION_SECRET: KeyRound,
  TOKEN_ENCRYPTION_KEY: KeyRound,
};

export function SetupRequired({ missing, platform }: { missing: MissingCheck[]; platform?: string | null }) {
  const { d } = useI18n();
  const onVercel = platform === "vercel";

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5 rounded-lg bg-(--color-warn-soft) px-3 py-2.5">
        <AlertTriangle size={16} className="mt-0.5 shrink-0 text-(--color-warn)" />
        <div>
          <p className="text-sm font-medium text-(--color-warn)">{d.setup.title}</p>
          <p className="mt-1 text-xs leading-5 text-(--color-fg-muted)">{d.setup.text}</p>
        </div>
      </div>

      <ol className="space-y-2.5">
        {missing.map((item, i) => {
          const Icon = ICONS[item.name] ?? KeyRound;
          return (
            <li key={item.name} className="flex gap-2.5 rounded-md border border-(--color-border) bg-(--color-panel-2) p-3">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-(--color-panel-3) text-[11px] font-semibold">
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Icon size={13} className="text-(--color-fg-faint)" />
                  <code className="font-mono text-xs font-semibold text-(--color-fg)">{item.name}</code>
                </div>
                {item.problem && <p className="mt-1 text-[11px] leading-5 text-(--color-fg-muted)">{item.problem}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="rounded-md border border-(--color-border) bg-(--color-panel-2) p-3">
        <p className="text-xs font-medium">{d.setup.docs}</p>
        <p className="mt-1 text-[11px] leading-5 text-(--color-fg-muted)">
          {onVercel ? (
            <>
              Vercel → your project → <b>Settings → Environment Variables</b>. Add each one for the{" "}
              <b>Production</b> environment, then open <b>Deployments</b> and <b>Redeploy</b> — variables are only
              picked up by a new deployment.
            </>
          ) : (
            <>
              Add them to the <code className="font-mono">.env</code> file in the project root, then restart the app.
            </>
          )}
        </p>
        <p className="mt-2 text-[11px] leading-5 text-(--color-fg-faint)">
          After redeploying you still need to create the first administrator once — see{" "}
          <code className="font-mono">docs/DEPLOYMENT.md</code> §9.
        </p>
      </div>

      <button
        onClick={() => window.location.reload()}
        className="flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-(--color-border-strong) text-sm font-medium text-(--color-fg) transition-colors hover:bg-(--color-panel-2)"
      >
        <RefreshCw size={14} />
        {d.common.tryAgain}
      </button>
    </div>
  );
}
