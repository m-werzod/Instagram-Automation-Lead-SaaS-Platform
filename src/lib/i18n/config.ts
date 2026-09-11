/**
 * Localization config — shared by server and client code.
 * Uzbek is the product's default language; English and Russian are complete
 * alternatives. The choice persists in a cookie so both server components
 * (html lang, initial render) and client components agree.
 */

export const LOCALES = ["uz", "en", "ru"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "uz";

export const LOCALE_COOKIE = "app_locale";
/** ~1 year — a preference, not a credential. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const LOCALE_LABELS: Record<Locale, string> = {
  uz: "O‘zbekcha",
  en: "English",
  ru: "Русский",
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function normalizeLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}
