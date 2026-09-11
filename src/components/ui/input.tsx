import * as React from "react";
import { cn } from "@/lib/utils";

const baseField =
  "w-full rounded-lg border border-(--color-border-strong) bg-white px-3 text-sm text-(--color-fg) placeholder:text-(--color-fg-faint) focus:outline-2 focus:outline-offset-0 focus:outline-(--color-accent) disabled:opacity-50 disabled:bg-(--color-panel-2)";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(baseField, "h-9", className)} {...props} />,
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(baseField, "min-h-20 py-2 leading-5", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn(baseField, "h-9 appearance-none bg-no-repeat pr-8", className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238494ac' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundPosition: "right 10px center",
      }}
      {...props}
    >
      {children}
    </select>
  ),
);
Select.displayName = "Select";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1.5 block text-xs font-medium text-(--color-fg-muted)", className)} {...props} />;
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <Label>{label}</Label>
      {children}
      {hint && <p className="mt-1 text-[11px] leading-4 text-(--color-fg-faint)">{hint}</p>}
    </div>
  );
}

/** Segmented control — a row of mutually-exclusive options (shape/size pickers). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: React.ReactNode; title?: string }>;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex w-full rounded-lg border border-(--color-border-strong) bg-(--color-panel-2) p-0.5", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
            value === o.value
              ? "bg-white text-(--color-fg) shadow-sm"
              : "text-(--color-fg-muted) hover:text-(--color-fg)",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
