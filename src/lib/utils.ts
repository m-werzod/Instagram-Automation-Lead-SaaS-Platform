import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { DEFAULT_LOCALE, LOCALE_COOKIE } from "@/lib/i18n/config";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** BCP-47 tags used for date/number formatting per UI locale. */
const INTL_LOCALE: Record<string, string> = {
  uz: "uz-Latn-UZ",
  ru: "ru-RU",
  en: "en-GB",
};

/** The visitor's UI locale (cookie on the client, Uzbek default elsewhere). */
function currentIntlLocale(): string {
  let code: string = DEFAULT_LOCALE;
  if (typeof document !== "undefined") {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${LOCALE_COOKIE}=(\\w+)`));
    if (m?.[1]) code = m[1];
  }
  return INTL_LOCALE[code] ?? INTL_LOCALE[DEFAULT_LOCALE]!;
}

export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  try {
    return date.toLocaleString(currentIntlLocale(), {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return date.toLocaleString("en-GB");
  }
}

export function timeAgo(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  const s = Math.floor((Date.now() - date.getTime()) / 1000);
  try {
    const rtf = new Intl.RelativeTimeFormat(currentIntlLocale(), { numeric: "always", style: "narrow" });
    if (s < 60) return rtf.format(-s, "second");
    if (s < 3600) return rtf.format(-Math.floor(s / 60), "minute");
    if (s < 86400) return rtf.format(-Math.floor(s / 3600), "hour");
    return rtf.format(-Math.floor(s / 86400), "day");
  } catch {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
}

export function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function centsToMoney(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "—";
  try {
    return new Intl.NumberFormat(currentIntlLocale(), { style: "currency", currency }).format(cents / 100);
  } catch {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  }
}
