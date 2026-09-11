"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Instagram } from "lucide-react";
import { useI18n } from "@/lib/i18n/provider";
import { useAccounts } from "@/components/shell/account-context";
import { PageHeader, EmptyState } from "@/components/ui/page-header";
import { IconChip } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/input";
import { AgentsTab } from "./agents-tab";
import { RulesTab } from "./rules-tab";
import { KnowledgeTab } from "./knowledge-tab";

/**
 * AI & Automation — one place for everything the platform does on its own:
 * agents (who answers), rules (when → then), knowledge (what the AI may say).
 * The active tab lives in ?tab= so every tab is linkable.
 */

const TABS = ["agents", "rules", "knowledge"] as const;
type Tab = (typeof TABS)[number];

export default function AutomationPage() {
  return (
    <React.Suspense fallback={null}>
      <AutomationInner />
    </React.Suspense>
  );
}

function AutomationInner() {
  const { d } = useI18n();
  const { selected, loading } = useAccounts();
  const router = useRouter();
  const params = useSearchParams();

  const raw = params.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(raw ?? "") ? (raw as Tab) : "agents";

  if (loading) {
    return <div className="py-20 text-center text-sm text-(--color-fg-muted)">{d.common.loading}</div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title={d.automation.title} description={d.automation.subtitle} accent="var(--color-mod-ai)" />

      {!selected ? (
        <EmptyState
          icon={
            <IconChip color="var(--color-mod-instagram)" size={48}>
              <Instagram size={22} />
            </IconChip>
          }
          title={d.instagram.connectTitle}
          action={
            <Button asChild variant="instagram">
              <Link href="/instagram">{d.instagram.connectButton}</Link>
            </Button>
          }
        />
      ) : (
        <>
          <Segmented
            className="max-w-md"
            value={tab}
            onChange={(v) => router.replace(`/automation?tab=${v}`, { scroll: false })}
            options={TABS.map((t) => ({ value: t, label: d.automation.tabs[t] }))}
          />

          {tab === "agents" && <AgentsTab accountId={selected.id} />}
          {tab === "rules" && <RulesTab accountId={selected.id} />}
          {tab === "knowledge" && <KnowledgeTab accountId={selected.id} />}
        </>
      )}
    </div>
  );
}
