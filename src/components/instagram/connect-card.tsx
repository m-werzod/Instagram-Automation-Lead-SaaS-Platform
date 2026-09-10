"use client";

import * as React from "react";
import Link from "next/link";
import { Instagram, ExternalLink, AlertTriangle, CheckCircle2, Plug } from "lucide-react";
import { api } from "@/lib/client/api";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge, StatusDot } from "@/components/ui/badge";

/**
 * The single entry point for linking an Instagram account.
 *
 * Pressing Connect performs a real full-page navigation to
 * /api/meta/oauth/start, which redirects the browser to Instagram's own
 * authorization screen — that is where the admin picks the account and grants
 * access. Nothing is simulated here.
 *
 * If the Meta app credentials are missing the button is not offered at all;
 * the setup steps are shown instead, because the redirect could not succeed.
 */

interface ConfigStatus {
  configured: boolean;
  missing: string[];
  appId: string | null;
  redirectUri: string;
  webhookUrl: string;
}

interface AccountLite {
  id: string;
  username: string;
  status: string;
  connectionMode: "INSTAGRAM_LOGIN" | "FACEBOOK_LOGIN";
  isDemo: boolean;
}

export function InstagramConnectCard({ compact = false }: { compact?: boolean }) {
  const [config, setConfig] = React.useState<ConfigStatus | null>(null);
  const [accounts, setAccounts] = React.useState<AccountLite[] | null>(null);

  React.useEffect(() => {
    api<ConfigStatus>("/api/meta/config-status", { silent: true }).then(setConfig).catch(() => undefined);
    api<{ accounts: AccountLite[] }>("/api/instagram/accounts", { silent: true })
      .then((d) => setAccounts(d.accounts))
      .catch(() => undefined);
  }, []);

  const real = accounts?.filter((a) => !a.isDemo) ?? [];
  const live = real.filter((a) => a.status === "CONNECTED");

  return (
    <Card className="border-[--color-mod-instagram]/30">
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <Instagram size={16} style={{ color: "var(--color-mod-instagram)" }} />
            Instagram Connection
          </span>
        }
        description="Link your Instagram account through Meta's official authorization. You will be sent to Instagram to approve access — we never ask for your Instagram password."
        actions={
          accounts === null ? null : live.length > 0 ? (
            <StatusDot ok label={`${live.length} connected`} />
          ) : (
            <StatusDot ok={false} label="Not connected" />
          )
        }
      />
      <CardBody className="space-y-4">
        {/* connected accounts */}
        {real.length > 0 && (
          <div className="space-y-1.5">
            {real.map((a) => (
              <div
                key={a.id}
                className="flex items-center justify-between rounded-md border border-[--color-border] bg-[--color-panel-2] px-3 py-2"
              >
                <span className="flex items-center gap-2 text-sm">
                  <CheckCircle2 size={14} className="text-[--color-ok]" />@{a.username}
                  <Badge>{a.connectionMode === "INSTAGRAM_LOGIN" ? "Instagram Login" : "Facebook Login"}</Badge>
                </span>
                <StatusDot ok={a.status === "CONNECTED"} warn={a.status === "ERROR"} label={a.status.toLowerCase()} />
              </div>
            ))}
          </div>
        )}

        {config === null && <p className="text-xs text-[--color-fg-muted]">Checking configuration…</p>}

        {/* ready → offer the real redirect */}
        {config?.configured && (
          <>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="lg">
                {/* full page navigation → Meta OAuth → instagram.com approval screen */}
                <a href="/api/meta/oauth/start?mode=instagram">
                  <Instagram size={16} />
                  {real.length > 0 ? "Connect another account" : "Connect Instagram"}
                  <ExternalLink size={13} />
                </a>
              </Button>
              <Button asChild variant="secondary" size="lg" title="Required only if you want to run paid ad campaigns">
                <a href="/api/meta/oauth/start?mode=facebook">
                  Connect with Facebook (for ads)
                  <ExternalLink size={13} />
                </a>
              </Button>
            </div>
            <p className="text-[11px] leading-5 text-[--color-fg-faint]">
              What happens next: you are redirected to Instagram, you choose the professional account and approve the
              permissions, then Instagram sends you back here. Requires an Instagram <b>Business</b> or{" "}
              <b>Creator</b> account — a personal account cannot be automated by any API.
            </p>
          </>
        )}

        {/* not ready → say why, and exactly what to do */}
        {config && !config.configured && (
          <div className="rounded-md border border-[--color-warn]/40 bg-[--color-warn]/10 p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-[--color-warn]">
              <AlertTriangle size={15} />
              One-time setup needed before you can connect
            </div>
            <p className="mt-1.5 text-xs leading-5 text-[--color-fg-muted]">
              Connecting sends you to Meta, and Meta only accepts the request from a registered app. These values are
              still empty in your <code className="font-mono">.env</code>:{" "}
              <span className="font-mono text-[--color-warn]">{config.missing.join(", ")}</span>
            </p>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs leading-5 text-[--color-fg-muted]">
              <li>
                Create an app at{" "}
                <a
                  className="text-[--color-accent] underline"
                  href="https://developers.facebook.com/apps"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  developers.facebook.com/apps
                </a>{" "}
                and add the <b>Instagram</b> product.
              </li>
              <li>
                Register this redirect URI in the app:
                <br />
                <code className="font-mono text-[10px] text-[--color-fg]">{config.redirectUri}</code>
              </li>
              <li>
                Copy the App ID and App Secret into <code className="font-mono">.env</code> as{" "}
                <code className="font-mono">META_APP_ID</code> / <code className="font-mono">META_APP_SECRET</code>,
                set any value for <code className="font-mono">META_WEBHOOK_VERIFY_TOKEN</code>, then restart the app.
              </li>
            </ol>
            <p className="mt-2 text-[11px] text-[--color-fg-faint]">
              Full walkthrough in <code className="font-mono">README.md</code> §6.
            </p>
          </div>
        )}

        {!compact && (
          <div className="flex flex-wrap gap-2 border-t border-[--color-border] pt-3">
            <Button asChild variant="ghost" size="sm">
              <Link href="/settings/integrations/instagram">
                <Plug size={14} />
                Manage connection, permissions & webhooks
              </Link>
            </Button>
          </div>
        )}
      </CardBody>
    </Card>
  );
}
