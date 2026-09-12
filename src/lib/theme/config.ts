/**
 * Theme config — shared by server and client, mirroring the locale setup in
 * lib/i18n/config.ts so both preferences behave the same way (cookie, ~1 year,
 * server-rendered on first paint).
 *
 * Three preferences, one resolved value:
 *   light | dark  → explicit, wins over the operating system
 *   system        → follows the OS, and keeps following it when the OS changes
 */

export const THEMES = ["light", "dark", "system"] as const;
export type ThemePreference = (typeof THEMES)[number];

/** A preference resolves to exactly one of these; it is what `data-theme` holds. */
export type ResolvedTheme = "light" | "dark";

/** Follow the operating system until the admin says otherwise. */
export const DEFAULT_THEME: ThemePreference = "system";

export const THEME_COOKIE = "app_theme";
/** ~1 year — a preference, not a credential. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

export function normalizeTheme(value: unknown): ThemePreference {
  return isThemePreference(value) ? value : DEFAULT_THEME;
}

export const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/**
 * Resolves the preference to an actual theme on `<html data-theme>` BEFORE the
 * first paint, which is the only way to avoid a white flash for a dark-mode
 * admin. It has to be an inline, synchronous script: React has not hydrated
 * yet, and a stylesheet alone cannot read the cookie.
 *
 * Deliberately tiny and total — any failure leaves the light default in place
 * rather than breaking the page.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${THEME_COOKIE}=([^;]*)/);var p=m?decodeURIComponent(m[1]):"${DEFAULT_THEME}";var dark=p==="dark"||(p!=="light"&&window.matchMedia("${DARK_MEDIA_QUERY}").matches);document.documentElement.setAttribute("data-theme",dark?"dark":"light");}catch(e){}})();`;
