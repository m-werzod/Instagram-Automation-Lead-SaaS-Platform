import { cookies } from "next/headers";
import { DEFAULT_THEME, normalizeTheme, THEME_COOKIE, type ThemePreference } from "./config";

/**
 * Server-component helper (root layout). An explicit light/dark preference is
 * rendered straight onto `<html data-theme>`, so those admins never depend on
 * the inline script at all; "system" is left for the script to resolve.
 */
export async function getThemePreference(): Promise<ThemePreference> {
  try {
    const store = await cookies();
    return normalizeTheme(store.get(THEME_COOKIE)?.value);
  } catch {
    return DEFAULT_THEME;
  }
}
