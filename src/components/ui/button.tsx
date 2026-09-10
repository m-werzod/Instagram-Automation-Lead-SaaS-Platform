import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[--color-accent] cursor-pointer select-none",
  {
    variants: {
      variant: {
        default: "bg-[--color-accent] text-white hover:bg-[--color-accent-hover]",
        secondary: "bg-[--color-panel-2] text-[--color-fg] border border-[--color-border-strong] hover:border-[--color-fg-faint]",
        ghost: "text-[--color-fg-muted] hover:text-[--color-fg] hover:bg-[--color-panel-2]",
        danger: "bg-[--color-danger]/15 text-[--color-danger] border border-[--color-danger]/40 hover:bg-[--color-danger]/25",
        success: "bg-[--color-ok]/15 text-[--color-ok] border border-[--color-ok]/40 hover:bg-[--color-ok]/25",
        outline: "border border-[--color-border-strong] text-[--color-fg] hover:bg-[--color-panel-2]",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-7 px-2.5 text-xs",
        lg: "h-10 px-5",
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
