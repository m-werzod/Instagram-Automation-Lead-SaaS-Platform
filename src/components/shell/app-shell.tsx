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
  ClipboardList,
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
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/client/api";
import { AccountProvider, useAccounts } from "./account-context";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

/**
 * Sidebar navigation. Items are grouped by purpose, named in plain language,
 * and colour-coded per module so a section is recognisable before reading it.
 * `what` is the one-line explanation surfaced on hover.
 */
interface NavItem {
  href: string;
  label: string;
  what: string;
  icon: LucideIcon;
  color: string;
}

const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "Overview",
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        what: "System health and today's numbers at a glance",
        icon: LayoutDashboard,
        color: "var(--color-mod-overview)",
      },
      {
        href: "/analytics",
        label: "Analytics",
        what: "Messages, leads, AI cost and Instagram insights",
        icon: BarChart3,
        color: "var(--color-mod-overview)",
      },
    ],
  },
  {
    title: "Instagram",
    items: [
      {
        href: "/instagram",
        label: "Accounts",
        what: "The Instagram accounts connected to this platform",
        icon: Instagram,
        color: "var(--color-mod-instagram)",
      },
      {
        href: "/content",
        label: "Posts & Reels",
        what: "Your published content, AI analysis and CTA setup",
        icon: Film,
        color: "var(--color-mod-content)",
      },
      {
        href: "/conversations",
        label: "Messages",
        what: "Instagram DM conversations — read, reply, take over from AI",
        icon: MessagesSquare,
        color: "var(--color-mod-content)",
      },
    ],
  },
  {
    title: "Automation",
    items: [
      {
        href: "/ai-agents",
        label: "AI Agents",
        what: "The assistants that answer your DMs automatically",
        icon: Bot,
        color: "var(--color-mod-ai)",
      },
      {
        href: "/crm/lead-flows",
        label: "Lead Forms",
        what: "Question-by-question forms sent inside Instagram DMs",
        icon: ClipboardList,
        color: "var(--color-mod-ai)",
      },
      {
        href: "/automations",
        label: "Automations",
        what: "If-this-then-that rules (trigger → condition → action)",
        icon: Workflow,
        color: "var(--color-mod-ai)",
      },
      {
        href: "/knowledge",
        label: "Knowledge",
        what: "Business documents the AI is allowed to quote from",
        icon: BookOpen,
        color: "var(--color-mod-ai)",
      },
    ],
  },
  {
    title: "Customers",
    items: [
      {
        href: "/leads",
        label: "Leads (CRM)",
        what: "Everyone who submitted their details, by pipeline stage",
        icon: Users,
        color: "var(--color-mod-leads)",
      },
    ],
  },
  {
    title: "Advertising",
    items: [
      {
        href: "/campaigns",
        label: "Ad Campaigns",
        what: "Paid Meta campaigns — costs money, always needs confirmation",
        icon: Megaphone,
        color: "var(--color-mod-ads)",
      },
    ],
  },
  {
    title: "System",
    items: [
      {
        href: "/settings/integrations/instagram",
        label: "Connect Instagram",
        what: "Link an Instagram account through official Meta authorization",
        icon: Plug,
        color: "var(--color-mod-instagram)",
      },
      {
        href: "/settings",
        label: "Settings",
        what: "Master switches, spending safety and administrators",
        icon: Settings,
        color: "var(--color-mod-system)",
      },
      {
        href: "/audit-logs",
        label: "Audit Log",
        what: "Who did what, and when",
        icon: ScrollText,
        color: "var(--color-mod-system)",
      },
    ],
  },
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
    <Link href="/settings" title="Master automation switch — click to configure">
      <Badge tone={master ? "ok" : "danger"} className="cursor-pointer px-2 py-1">
        <Power size={12} />
        {master ? "Automation ON" : "Automation OFF"}
      </Badge>
    </Link>
  );
}

interface AdminIdentity {
  name: string;
  login: string;
  role: string;
}

function isActivePath(pathname: string, href: string): boolean {
  if (href === "/settings") return pathname === "/settings";
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(href + "/");
}

function Shell({ admin, children }: { admin: AdminIdentity; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { accounts, selectedId, setSelectedId } = useAccounts();
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => setMobileOpen(false), [pathname]);

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      router.push("/login");
    } catch {
      toast.error("Logout failed");
    }
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside
        className={cn(
          "z-40 flex w-64 shrink-0 flex-col border-r border-[--color-border] bg-[--color-panel]",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:shadow-2xl max-lg:transition-transform",
          mobileOpen ? "max-lg:translate-x-0" : "max-lg:-translate-x-full",
        )}
      >
        <div className="flex h-14 items-center gap-2.5 border-b border-[--color-border] px-4">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-[--color-accent] text-xs font-bold text-white">
            IG
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold leading-tight">Instagram Automation</div>
            <div className="text-[10px] text-[--color-fg-faint]">Control Center</div>
          </div>
          <button
            className="rounded p-1 text-[--color-fg-muted] hover:bg-[--color-panel-2] lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-label="Close menu"
          >
            <X size={16} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2.5 py-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="mb-4 last:mb-0">
              <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-[--color-fg-faint]">
                {group.title}
              </div>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const active = isActivePath(pathname, item.href);
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={item.what}
                      className={cn(
                        "group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] font-medium transition-colors",
                        active
                          ? "bg-[--color-panel-3] text-[--color-fg]"
                          : "text-[--color-fg-muted] hover:bg-[--color-panel-2] hover:text-[--color-fg]",
                      )}
                    >
                      <Icon
                        size={16}
                        className="shrink-0 transition-opacity"
                        style={{ color: item.color, opacity: active ? 1 : 0.75 }}
                      />
                      <span className="truncate">{item.label}</span>
                      {active && (
                        <span
                          className="ml-auto h-4 w-1 rounded-full"
                          style={{ background: item.color }}
                          aria-hidden
                        />
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-[--color-border] p-3">
          <div className="flex items-center gap-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[--color-panel-3] text-xs font-semibold">
              {admin.name.charAt(0).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium">{admin.name}</div>
              <div className="truncate text-[10px] text-[--color-fg-faint]">
                {admin.login} · {admin.role}
              </div>
            </div>
            <button
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              className="rounded p-1.5 text-[--color-fg-muted] hover:bg-[--color-panel-2] hover:text-[--color-danger]"
            >
              <LogOut size={15} />
            </button>
          </div>
        </div>
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setMobileOpen(false)} aria-hidden />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[--color-border] bg-[--color-panel] px-4">
          <button
            className="rounded p-1.5 text-[--color-fg-muted] hover:bg-[--color-panel-2] lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={18} />
          </button>

          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden text-xs text-[--color-fg-faint] sm:inline">Working on</span>
            <Select
              className="h-8 w-full min-w-0 max-w-56 text-xs"
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={accounts.length === 0}
              aria-label="Selected Instagram account"
            >
              {accounts.length === 0 && <option value="">No Instagram account connected</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                  {a.isDemo ? " (demo)" : ""}
                  {a.status !== "CONNECTED" ? ` — ${a.status.toLowerCase()}` : ""}
                </option>
              ))}
            </Select>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <MasterSwitchPill />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-5">{children}</main>
      </div>
    </div>
  );
}

export function AppShell(props: { admin: AdminIdentity; children: React.ReactNode }) {
  return (
    <AccountProvider>
      <Shell {...props} />
    </AccountProvider>
  );
}
