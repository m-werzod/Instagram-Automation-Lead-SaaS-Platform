"use client";

import * as React from "react";
import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, normalizeLocale, type Locale } from "./config";
import { DICTIONARIES, type Dictionary } from "./dictionaries";

/**
 * Client-side localization. The server layout reads the cookie and passes the
 * initial locale so the first paint is already in the right language; changing
 * the language re-renders instantly and persists via cookie (no reload).
 */

interface I18nContextValue {
  locale: Locale;
  /** The full typed dictionary for the current locale. */
  d: Dictionary;
  setLocale: (locale: Locale) => void;
}

const I18nContext = React.createContext<I18nContextValue | null>(null);

export function I18nProvider({ initialLocale, children }: { initialLocale?: Locale; children: React.ReactNode }) {
  const [locale, setLocaleState] = React.useState<Locale>(normalizeLocale(initialLocale ?? DEFAULT_LOCALE));

  const setLocale = React.useCallback((next: Locale) => {
    setLocaleState(next);
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
    document.documentElement.lang = next;
  }, []);

  const value = React.useMemo<I18nContextValue>(
    () => ({ locale, d: DICTIONARIES[locale], setLocale }),
    [locale, setLocale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** `const { d, locale, setLocale } = useI18n()` — d is fully typed; no string keys, no typos. */
export function useI18n(): I18nContextValue {
  const ctx = React.useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside <I18nProvider>");
  return ctx;
}
