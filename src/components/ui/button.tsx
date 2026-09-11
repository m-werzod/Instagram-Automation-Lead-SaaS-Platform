import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--color-accent) cursor-pointer select-none",
  {
    variants: {
      variant: {
        default: "bg-(--color-accent) text-white shadow-sm hover:bg-(--color-accent-hover) active:scale-[0.98]",
        secondary:
          "bg-white text-(--color-fg) border border-(--color-border-strong) shadow-sm hover:bg-(--color-panel-2) hover:border-(--color-fg-faint)",
        ghost: "text-(--color-fg-muted) hover:text-(--color-fg) hover:bg-(--color-panel-2)",
        danger: "bg-(--color-danger-soft) text-(--color-danger) border border-(--color-danger)/30 hover:bg-(--color-danger)/15",
        success: "bg-(--color-ok-soft) text-(--color-ok) border border-(--color-ok)/30 hover:bg-(--color-ok)/15",
        outline: "border border-(--color-border-strong) bg-white text-(--color-fg) shadow-sm hover:bg-(--color-panel-2)",
        instagram: "ig-gradient text-white shadow-sm hover:opacity-90 active:scale-[0.98]",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-7 px-2.5 text-xs",
        lg: "h-11 px-6 text-[15px]",
        icon: "h-8 w-8",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...(asChild ? {} : { type: type ?? "button" })}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
