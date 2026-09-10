"use client";

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors",
      "data-[state=checked]:bg-[--color-on] data-[state=unchecked]:bg-[--color-border-strong]",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[--color-accent] disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px] data-[state=unchecked]:translate-x-0.5" />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

/** Standard settings row: label + description + switch (spec §36 settings-first UX). */
export function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  danger,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className={cn("text-sm font-medium", danger && "text-[--color-danger]")}>{label}</div>
        {description && <div className="text-xs text-[--color-fg-muted] mt-0.5">{description}</div>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <span className={cn("text-[10px] font-semibold tracking-wide", checked ? "text-[--color-on]" : "text-[--color-off]")}>
          {checked ? "ON" : "OFF"}
        </span>
        <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      </div>
    </div>
  );
}
