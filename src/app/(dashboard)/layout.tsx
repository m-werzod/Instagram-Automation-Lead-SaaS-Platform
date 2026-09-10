import { requireAuthPage } from "@/lib/auth/guard";
import { AppShell } from "@/components/shell/app-shell";

/** Server-side auth gate for every dashboard page (full DB session check). */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuthPage();
  return <AppShell admin={auth.admin}>{children}</AppShell>;
}
