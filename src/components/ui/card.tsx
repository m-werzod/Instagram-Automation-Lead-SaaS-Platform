import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-[--color-border] bg-[--color-panel]", className)}
      {...props}
    />
  );
}

export function CardHeader({
  className,
  title,
  description,
  actions,
  ...props
}: Omit<React.HTMLAttributes<HTMLDivElement>, "title"> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 border-b border-[--color-border] px-4 py-3", className)} {...props}>
      <div className="min-w-0">
        {title !== undefined && <h3 className="text-sm font-semibold leading-6">{title}</h3>}
        {description !== undefined && <p className="text-xs text-[--color-fg-muted] mt-0.5">{description}</p>}
        {props.children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-4 py-3", className)} {...props} />;
}
