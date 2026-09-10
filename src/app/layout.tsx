import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "IG Automation Control Center", template: "%s · IG Automation" },
  description: "Private Instagram automation platform",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster
          theme="dark"
          position="top-right"
          toastOptions={{
            style: { background: "#171c27", border: "1px solid #2f3948", color: "#e6e9ef" },
          }}
        />
      </body>
    </html>
  );
}
