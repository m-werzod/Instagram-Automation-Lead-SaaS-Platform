import { cookies } from "next/headers";
import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale, type Locale } from "./config";
import { DICTIONARIES, type Dictionary } from "./dictionaries";

/** Server-component helpers (root layout, public landing page). */

export async function getLocale(): Promise<Locale> {
  try {
    const store = await cookies();
    return normalizeLocale(store.get(LOCALE_COOKIE)?.value);
  } catch {
    return DEFAULT_LOCALE;
  }
}

export async function getDictionary(): Promise<{ locale: Locale; d: Dictionary }> {
  const locale = await getLocale();
  return { locale, d: DICTIONARIES[locale] };
}
