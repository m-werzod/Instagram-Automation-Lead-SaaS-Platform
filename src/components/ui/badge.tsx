import * as React from "react";
import { cn } from "@/lib/utils";

const styles: Record<string, string> = {
  default: "bg-[--color-panel-2] text-[--color-fg-muted] border-[--color-border-strong]",
  ok: "bg-[--color-ok-soft] text-[--color-ok] border-[--color-ok]/25",
  warn: "bg-[--color-warn-soft] text-[--color-warn] border-[--color-warn]/25",
  danger: "bg-[--color-danger-soft] text-[--color-danger] border-[--color-danger]/25",
  accent: "bg-[--color-accent-soft] text-[--color-accent] border-[--color-accent]/25",
  info: "bg-[--color-info-soft] text-[--color-info] border-[--color-info]/25",
};

export function Badge({
  tone = "default",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: keyof typeof styles }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium leading-4",
        styles[tone],
        className,
      )}
      {...props}
    />
  );
}

/** ● status dot + label */
export function StatusDot({ ok, label, warn }: { ok: boolean; label: string; warn?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          warn ? "bg-[--color-warn]" : ok ? "bg-[--color-ok]" : "bg-[--color-fg-faint]",
        )}
      />
      <span className={ok || warn ? "text-[--color-fg]" : "text-[--color-fg-muted]"}>{label}</span>
    </span>
  );
}
