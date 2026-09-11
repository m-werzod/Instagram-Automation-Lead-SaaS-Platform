"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;

export function DialogContent({
  className,
  children,
  title,
  description,
  wide,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
  title: string;
  description?: string;
  wide?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={cn(
          "fixed left-1/2 top-1/2 z-50 max-h-[85vh] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-[--color-border] bg-white p-5 shadow-2xl",
          wide ? "max-w-3xl" : "max-w-lg",
          className,
        )}
        {...props}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
            {description && (
              <DialogPrimitive.Description className="mt-1 text-xs text-[--color-fg-muted]">
                {description}
              </DialogPrimitive.Description>
            )}
          </div>
          <DialogPrimitive.Close className="rounded p-1 text-[--color-fg-muted] hover:bg-[--color-panel-2] hover:text-[--color-fg]">
            <X size={16} />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
