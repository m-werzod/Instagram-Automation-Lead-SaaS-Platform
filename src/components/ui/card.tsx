import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-xl border border-(--color-border) bg-(--color-panel) shadow-(--shadow-card)", className)}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  title,
  description,
  actions,
  icon,
  ...props
}: Omit<React.HTMLAttributes<HTMLDivElement>, "title"> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** Optional colored icon chip, e.g. <span className="...">🎯</span> */
  icon?: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 border-b border-(--color-border) px-4 py-3.5", className)} {...props}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon}
        <div className="min-w-0">
          {title !== undefined && <h3 className="text-sm font-semibold leading-6">{title}</h3>}
          {description !== undefined && <p className="mt-0.5 text-xs text-(--color-fg-muted)">{description}</p>}
          {props.children}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3.5", className)} {...props} />;
}

/** Small colored icon chip used in card headers and nav. */
export function IconChip({
  color,
  children,
  className,
  size = 32,
}: {
  color: string;
  children: React.ReactNode;
  className?: string;
  size?: number;
}) {
  return (
    <span
      className={cn("grid shrink-0 place-items-center rounded-lg", className)}
      style={{ width: size, height: size, background: `color-mix(in srgb, ${color} 13%, white)`, color }}
      aria-hidden
    >
      {children}
    </span>
  );
}
