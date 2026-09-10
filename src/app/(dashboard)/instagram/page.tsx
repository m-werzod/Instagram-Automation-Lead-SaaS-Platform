"use client";

import * as React from "react";
import Link from "next/link";
import { useAccounts } from "@/components/shell/account-context";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/**
 * Instagram account control overview (spec §7). Data isolation note: every
 * module below operates strictly within the selected account.
 */
export default function InstagramPage() {
  const { accounts, selected, setSelectedId, loading } = useAccounts();

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Instagram accounts</h1>
        <Button asChild variant="secondary">
          <Link href="/settings/integrations/instagram">Connect / manage integration</Link>
        </Button>
      </div>

      {loading && <p className="text-sm text-[--color-fg-muted]">Loading…</p>}
      {!loading && accounts.length === 0 && (
        <Card>
          <CardBody className="py-10 text-center text-sm text-[--color-fg-muted]">
            No accounts connected.{" "}
            <Link href="/settings/integrations/instagram" className="text-[--color-accent] underline">
              Connect the first one →
            </Link>
          </CardBody>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {accounts.map((acc) => (
          <Card key={acc.id} className={acc.id === selected?.id ? "border-[--color-accent]/50" : undefined}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  @{acc.username}
                  {acc.isDemo && <Badge tone="warn">DEMO</Badge>}
                </span>
              }
              description={acc.connectionMode === "INSTAGRAM_LOGIN" ? "Instagram Login mode" : "Facebook Login mode (ads-capable)"}
              actions={<StatusDot ok={acc.status === "CONNECTED"} warn={acc.status === "ERROR"} label={acc.status} />}
            />
            <CardBody className="space-y-3">
              <div className="grid grid-cols-2 gap-1.5">
                {acc.capabilities.map((c) => (
                  <div key={c.key} className="flex items-center justify-between rounded border border-[--color-border] px-2 py-1.5 text-xs" title={c.reason}>
                    <span>{c.label}</span>
                    {c.available ? <span className="text-[--color-ok]">✓</span> : <span className="text-[--color-fg-faint]">—</span>}
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={acc.id === selected?.id ? "default" : "secondary"} onClick={() => setSelectedId(acc.id)}>
                  {acc.id === selected?.id ? "Selected" : "Work with this account"}
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <Link href="/ai-agents">Agents</Link>
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <Link href="/content">Content</Link>
                </Button>
                <Button asChild size="sm" variant="ghost">
                  <Link href="/conversations">Conversations</Link>
                </Button>
              </div>
              <p className="text-[11px] text-[--color-fg-faint]">
                Isolation: agents, prompts, conversations, content, leads, flows, automations and analytics are scoped
                to this account and never mixed with other accounts.
              </p>
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
