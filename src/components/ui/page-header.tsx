import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Standard page heading: what this screen is, in one plain sentence, plus its
 * primary actions. Every module uses it so pages are immediately identifiable.
 */
export function PageHeader({
  title,
  description,
  actions,
  accent,
  className,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** CSS colour for the left rule — use the module hue. */
  accent?: string;
  className?: string;
}) {
  return (
    <div className={cn("mb-5 flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="flex min-w-0 gap-3">
        {accent && <span className="mt-1 h-9 w-1.5 shrink-0 rounded-full" style={{ background: accent }} aria-hidden />}
        <div className="min-w-0">
          <h1 className="text-xl font-bold leading-tight tracking-tight">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-[13px] leading-5 text-(--color-fg-muted)">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Neutral empty-state block with an optional call to action. */
export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-(--color-border-strong) bg-(--color-panel) px-6 py-12 text-center">
      {icon && <div className="mb-3 flex justify-center">{icon}</div>}
      <p className="text-sm font-semibold">{title}</p>
      {description && <p className="mx-auto mt-1.5 max-w-md text-xs leading-5 text-(--color-fg-muted)">{description}</p>}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}
