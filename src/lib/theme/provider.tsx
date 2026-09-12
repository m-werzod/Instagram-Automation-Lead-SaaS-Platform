"use client";

import * as React from "react";
import {
  DARK_MEDIA_QUERY,
  DEFAULT_THEME,
  normalizeTheme,
  THEME_COOKIE,
  THEME_COOKIE_MAX_AGE,
  type ResolvedTheme,
  type ThemePreference,
} from "./config";

/**
 * Client-side theme state. The attribute on <html> is the single source of
 * truth for the CSS (see the [data-theme="dark"] block in globals.css); this
 * context only mirrors it for components that need to *know* the theme in JS
 * (the toggle's icon, the toast surface).
 */

interface ThemeContextValue {
  /** What the admin chose: light, dark, or follow-the-OS. */
  preference: ThemePreference;
  /** What that currently means on screen. */
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia(DARK_MEDIA_QUERY).matches ? "dark" : "light";
}

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

export function ThemeProvider({
  initialPreference,
  children,
}: {
  initialPreference?: ThemePreference;
  children: React.ReactNode;
}) {
  const [preference, setPreferenceState] = React.useState<ThemePreference>(
    normalizeTheme(initialPreference ?? DEFAULT_THEME),
  );
  /**
   * Starts as the light default on BOTH server and client so hydration always
   * matches; the effect below immediately corrects it from the DOM attribute
   * the inline script already set. The visible theme is never wrong — only this
   * JS mirror of it catches up a tick later.
   */
  const [resolved, setResolved] = React.useState<ResolvedTheme>(
    preference === "system" ? "light" : preference,
  );

  /** Paint the resolved theme onto <html>, briefly arming the crossfade. */
  const apply = React.useCallback((next: ResolvedTheme, animate: boolean) => {
    const root = document.documentElement;
    if (root.getAttribute("data-theme") === next) return;
    if (animate) {
      root.setAttribute("data-theme-switching", "");
      window.setTimeout(() => root.removeAttribute("data-theme-switching"), 220);
    }
    root.setAttribute("data-theme", next);
  }, []);

  // Adopt whatever the inline script resolved, without a flash on mount.
  React.useEffect(() => {
    const actual = resolve(preference);
    setResolved(actual);
    apply(actual, false);
  }, [preference, apply]);

  // "system" means *keep* following the OS, including while the app is open.
  React.useEffect(() => {
    if (preference !== "system") return;
    const mq = window.matchMedia(DARK_MEDIA_QUERY);
    const onChange = () => {
      const next = mq.matches ? "dark" : "light";
      setResolved(next);
      apply(next, true);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference, apply]);

  const setPreference = React.useCallback(
    (next: ThemePreference) => {
      setPreferenceState(next);
      const actual = resolve(next);
      setResolved(actual);
      apply(actual, true);
      document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`;
    },
    [apply],
  );

  const value = React.useMemo<ThemeContextValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
