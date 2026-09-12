"use client";

import * as React from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/provider";
import { useTheme } from "@/lib/theme/provider";
import { THEMES, type ThemePreference } from "@/lib/theme/config";

/**
 * Day / night / auto, as three visible choices rather than a blind cycle.
 *
 * A single cycling button is smaller but makes the admin click and *watch* to
 * find out what they get; with three segments the current mode is readable at a
 * glance (sun, moon, screen) and any mode is one click away. Icon-only by
 * default because the meaning is universal — the accessible name and tooltip
 * still carry the words, in the admin's language.
 */

const ICONS: Record<ThemePreference, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export function ThemeToggle({ className, showLabels }: { className?: string; showLabels?: boolean }) {
  const { d } = useI18n();
  const { preference, setPreference } = useTheme();

  return (
    <div
      role="group"
      aria-label={d.theme.label}
      title={d.theme.label}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-(--color-border-strong) bg-(--color-panel-2) p-0.5",
        className,
      )}
    >
      {THEMES.map((t) => {
        const Icon = ICONS[t];
        const active = preference === t;
        const label = d.theme.modes[t];
        return (
          <button
            key={t}
            type="button"
            onClick={() => setPreference(t)}
            aria-pressed={active}
            aria-label={label}
            title={label}
            className={cn(
              "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
              active
                ? "bg-(--color-panel) text-(--color-fg) shadow-(--shadow-card)"
                : "text-(--color-fg-faint) hover:text-(--color-fg)",
            )}
          >
            <Icon size={14} aria-hidden />
            {showLabels && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
