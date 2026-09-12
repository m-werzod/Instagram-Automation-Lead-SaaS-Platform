import type { Metadata } from "next";
import { getLocale } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/provider";
import { getThemePreference } from "@/lib/theme/server";
import { ThemeProvider } from "@/lib/theme/provider";
import { THEME_INIT_SCRIPT } from "@/lib/theme/config";
import { ThemedToaster } from "@/components/shell/themed-toaster";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Instagram Automation — Lead platform", template: "%s · Instagram Automation" },
  description: "Private Instagram automation and lead-generation platform",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const theme = await getThemePreference();

  return (
    // An explicit choice is rendered server-side so it is correct in the very
    // first byte of HTML; "system" is filled in by the inline script below
    // before the first paint. suppressHydrationWarning covers exactly that —
    // the script legitimately changes this attribute before React sees it.
    <html
      lang={locale}
      data-theme={theme === "system" ? undefined : theme}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider initialPreference={theme}>
          <I18nProvider initialLocale={locale}>{children}</I18nProvider>
          <ThemedToaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
