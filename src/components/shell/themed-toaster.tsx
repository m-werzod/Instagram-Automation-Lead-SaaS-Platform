"use client";

import { Toaster } from "sonner";
import { useTheme } from "@/lib/theme/provider";

/**
 * Toasts follow the app theme. They are portalled outside the normal tree and
 * styled inline by sonner, so they cannot inherit the surface tokens on their
 * own — the values are handed over explicitly as var() references, which keeps
 * them correct the instant the theme flips.
 */
export function ThemedToaster() {
  const { resolved } = useTheme();
  return (
    <Toaster
      theme={resolved}
      position="top-right"
      toastOptions={{
        style: {
          background: "var(--color-panel)",
          border: "1px solid var(--color-border)",
          color: "var(--color-fg)",
          boxShadow: "var(--shadow-pop)",
        },
      }}
    />
  );
}
