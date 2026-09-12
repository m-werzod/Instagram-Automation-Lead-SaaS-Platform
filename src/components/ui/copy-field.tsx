"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n/provider";

/**
 * A read-only value that exists to be pasted somewhere else (a redirect URI, a
 * webhook URL, a verify token). Shown in full and selectable — copy buttons
 * fail silently without clipboard permission, and these values are useless if
 * the admin cannot get at them.
 */
export function CopyField({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const { d } = useI18n();
  const [copied, setCopied] = React.useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(d.common.copied);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error(d.common.error);
    }
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-(--color-fg-muted)">{label}</span>
        {hint && <span className="truncate text-[10px] text-(--color-fg-faint)">{hint}</span>}
      </div>
      <div className="flex items-stretch gap-1.5">
        <code className="min-w-0 flex-1 select-all overflow-x-auto whitespace-nowrap rounded-lg border border-(--color-border-strong) bg-(--color-panel-2) px-2.5 py-2 font-mono text-[11px] leading-5 text-(--color-fg)">
          {value}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={d.common.copy}
          title={d.common.copy}
          className="shrink-0 cursor-pointer rounded-lg border border-(--color-border-strong) bg-(--color-panel) px-2.5 text-(--color-fg-muted) transition-colors hover:bg-(--color-panel-2) hover:text-(--color-fg)"
        >
          {copied ? <Check size={14} className="text-(--color-ok)" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}
