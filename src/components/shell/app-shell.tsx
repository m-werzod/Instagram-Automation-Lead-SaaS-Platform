"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Instagram,
  Bot,
  Film,
  Megaphone,
  Users,
  GitBranch,
  MessagesSquare,
  BookOpen,
  Workflow,
  BarChart3,
  Plug,
  Settings,
  ScrollText,
  LogOut,
  Power,
  Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/client/api";
import { AccountProvider, useAccounts } from "./account-context";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/instagram", label: "Instagram", icon: Instagram },
  { href: "/ai-agents", label: "AI Agents", icon: Bot },
  { href: "/content", label: "Content", icon: Film },
  { href: "/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/crm/lead-flows", label: "CRM · Lead Flows", icon: GitBranch },
  { href: "/conversations", label: "Conversations", icon: MessagesSquare },
  { href: "/knowledge", label: "Knowledge Base", icon: BookOpen },
  { href: "/automations", label: "Automations", icon: Workflow },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/settings/integrations/instagram", label: "Integrations", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/audit-logs", label: "Audit Logs", icon: ScrollText },
];

function MasterSwitchPill() {
  const [master, setMaster] = React.useState<boolean | null>(null);

  const load = React.useCallback(async () => {
    try {
      const data = await api<{ settings: { masterAutomationEnabled: boolean } }>("/api/settings/global", { silent: true });
      setMaster(data.settings.masterAutomationEnabled);
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    void load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  if (master === null) return null;
  return (
    <Link href="/settings" title="Master automation switch — configure in Settings">
      <Badge tone={master ? "ok" : "danger"} className="cursor-pointer">
        <Power size={11} />
        {master ? "AUTOMATION ON" : "AUTOMATION OFF"}
      </Badge>
    </Link>
  );
}

function Shell({ admin, children }: { admin: { name: string; email: string; role: string }; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { accounts, selectedId, setSelectedId } = useAccounts();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      router.push("/login");
    } catch {
      toast.error("Logout failed");
    }
  }

  const nav = (
    <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-0.5">
      {NAV.map((item) => {
        const active =
          pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href + "/")) ||
          (item.href === "/settings" && pathname === "/settings");
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            className={cn(
              "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors",
              active
                ? "bg-[--color-accent]/12 text-[--color-accent]"
                : "text-[--color-fg-muted] hover:bg-[--color-panel-2] hover:text-[--color-fg]",
            )}
          >
            <Icon size={16} className="shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* sidebar */}
      <aside
        className={cn(
          "z-40 flex w-60 shrink-0 flex-col border-r border-[--color-border] bg-[--color-panel]",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:transition-transform",
          mobileOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-[--color-border] px-4">
          <div className="grid h-7 w-7 place-items-center rounded bg-[--color-accent] text-xs font-bold text-white">IG</div>
          <div className="text-sm font-semibold leading-tight">
            Automation
            <div className="text-[10px] font-normal text-[--color-fg-faint]">Control Center</div>
          </div>
        </div>
        {nav}
        <div className="border-t border-[--color-border] p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">{admin.name}</div>
              <div className="truncate text-[10px] text-[--color-fg-faint]">
                {admin.email} · {admin.role}
              </div>
            </div>
            <button
              onClick={logout}
              title="Log out"
              className="rounded p-1.5 text-[--color-fg-muted] hover:bg-[--color-panel-2] hover:text-[--color-danger]"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>

      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/50 lg:hidden" onClick={() => setMobileOpen(false)} />}

      {/* main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[--color-border] bg-[--color-panel] px-4">
          <button className="lg:hidden text-[--color-fg-muted]" onClick={() => setMobileOpen(true)}>
            <Menu size={18} />
          </button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-[--color-fg-faint]">Account</span>
            <Select
              className="h-8 w-52 text-xs"
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={accounts.length === 0}
            >
              {accounts.length === 0 && <option value="">No accounts connected</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                  {a.isDemo ? " (DEMO)" : ""} {a.status !== "CONNECTED" ? `— ${a.status}` : ""}
                </option>
              ))}
            </Select>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <MasterSwitchPill />
          </div>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-5">{children}</main>
      </div>
    </div>
  );
}

export function AppShell(props: { admin: { name: string; email: string; role: string }; children: React.ReactNode }) {
  return (
    <AccountProvider>
      <Shell {...props} />
    </AccountProvider>
  );
}
