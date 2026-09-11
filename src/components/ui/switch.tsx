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
      "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors",
      "data-[state=checked]:bg-[--color-on] data-[state=unchecked]:bg-[--color-border-strong]",
      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[--color-accent] disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-5 w-5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[22px] data-[state=unchecked]:translate-x-0.5" />
  </SwitchPrimitive.Root>
));
Switch.displayName = "Switch";

/**
 * Standard settings row: label + description + ON/OFF pill + switch.
 * The state is readable without reading any text — green means working.
 */
export function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
  danger,
  onLabel = "ON",
  offLabel = "OFF",
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  danger?: boolean;
  onLabel?: string;
  offLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <div className={cn("text-sm font-medium", danger && "text-[--color-danger]")}>{label}</div>
        {description && <div className="mt-0.5 text-xs text-[--color-fg-muted]">{description}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[10px] font-bold tracking-wide",
            checked ? "bg-[--color-ok-soft] text-[--color-on]" : "bg-[--color-panel-2] text-[--color-off]",
          )}
        >
          {checked ? onLabel : offLabel}
        </span>
        <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      </div>
    </div>
  );
}
