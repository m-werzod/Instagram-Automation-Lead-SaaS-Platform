import type { Metadata } from "next";
import { Toaster } from "sonner";
import { getLocale } from "@/lib/i18n/server";
import { I18nProvider } from "@/lib/i18n/provider";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Instagram Automation — Lead platform", template: "%s · Instagram Automation" },
  description: "Private Instagram automation and lead-generation platform",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body>
        <I18nProvider initialLocale={locale}>{children}</I18nProvider>
        <Toaster
          theme="light"
          position="top-right"
          toastOptions={{
            style: { background: "#ffffff", border: "1px solid #e4e9f2", color: "#101828", boxShadow: "0 4px 12px rgb(16 24 40 / 0.08)" },
          }}
        />
      </body>
    </html>
  );
}
