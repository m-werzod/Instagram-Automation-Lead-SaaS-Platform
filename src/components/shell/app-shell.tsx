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
  MessagesSquare,
  MousePointerClick,
  Settings,
  LogOut,
  Power,
  Menu,
  X,
  Globe,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/client/api";
import { useI18n } from "@/lib/i18n/provider";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n/config";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { AccountProvider, useAccounts } from "./account-context";
import { Select } from "@/components/ui/input";
import { ThemeToggle } from "./theme-toggle";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

/**
 * Sidebar navigation — 7 top-level destinations, in plain language, each with
 * its own hue so a section is recognisable before reading. Posts/Messages sit
 * visually under Instagram because that is where they live conceptually.
 */
interface NavItem {
  href: string;
  label: (d: Dictionary) => string;
  what: (d: Dictionary) => string;
  icon: LucideIcon;
  color: string;
  child?: boolean;
}

const NAV: NavItem[] = [
  {
    href: "/dashboard",
    label: (d) => d.nav.dashboard,
    what: (d) => d.nav.tagline.dashboard,
    icon: LayoutDashboard,
    color: "var(--color-mod-overview)",
  },
  {
    href: "/instagram",
    label: (d) => d.nav.instagram,
    what: (d) => d.nav.tagline.instagram,
    icon: Instagram,
    color: "var(--color-mod-instagram)",
  },
  {
    href: "/content",
    label: (d) => d.nav.content,
    what: (d) => d.nav.tagline.content,
    icon: Film,
    color: "var(--color-mod-content)",
    child: true,
  },
  {
    href: "/conversations",
    label: (d) => d.nav.messages,
    what: (d) => d.nav.tagline.messages,
    icon: MessagesSquare,
    color: "var(--color-mod-content)",
    child: true,
  },
  {
    href: "/lead-button",
    label: (d) => d.nav.leadButton,
    what: (d) => d.nav.tagline.leadButton,
    icon: MousePointerClick,
    color: "var(--color-accent)",
  },
  {
    href: "/leads",
    label: (d) => d.nav.leads,
    what: (d) => d.nav.tagline.leads,
    icon: Users,
    color: "var(--color-mod-leads)",
  },
  {
    href: "/automation",
    label: (d) => d.nav.automation,
    what: (d) => d.nav.tagline.automation,
    icon: Bot,
    color: "var(--color-mod-ai)",
  },
  {
    href: "/campaigns",
    label: (d) => d.nav.ads,
    what: (d) => d.nav.tagline.ads,
    icon: Megaphone,
    color: "var(--color-mod-ads)",
  },
  {
    href: "/settings",
    label: (d) => d.nav.settings,
    what: (d) => d.nav.tagline.settings,
    icon: Settings,
    color: "var(--color-mod-system)",
  },
];

function MasterSwitchPill() {
  const { d } = useI18n();
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
    <Link href="/settings">
      <Badge tone={master ? "ok" : "danger"} className="cursor-pointer px-2 py-1">
        <Power size={12} />
        {master ? d.shell.automationOn : d.shell.automationOff}
      </Badge>
    </Link>
  );
}

function LanguageSwitcher({ compact }: { compact?: boolean }) {
  const { d, locale, setLocale } = useI18n();
  return (
    <div className="flex items-center gap-1.5" title={d.common.language}>
      <Globe size={14} className="shrink-0 text-(--color-fg-faint)" aria-hidden />
      <Select
        aria-label={d.common.language}
        className={cn("h-8 text-xs", compact ? "w-[4.5rem]" : "w-32")}
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {compact ? l.toUpperCase() : LOCALE_LABELS[l]}
          </option>
        ))}
      </Select>
    </div>
  );
}

interface AdminIdentity {
  name: string;
  login: string;
  role: string;
}

function isActivePath(pathname: string, href: string): boolean {
  if (href === "/settings") return pathname === "/settings" || pathname.startsWith("/settings/");
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(href + "/");
}

/** Sidebar contents — reused by the desktop rail and the mobile drawer. */
function SidebarBody({
  admin,
  pathname,
  onNavigate,
  onLogout,
}: {
  admin: AdminIdentity;
  pathname: string;
  onNavigate?: () => void;
  onLogout: () => void;
}) {
  const { d } = useI18n();
  return (
    <>
      <div className="flex h-14 items-center gap-2.5 border-b border-(--color-border) px-4">
        <div className="ig-gradient grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white shadow-sm">
          <Instagram size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-bold leading-tight">{d.shell.appName}</div>
          <div className="text-[10px] text-(--color-fg-faint)">{d.shell.appTagline}</div>
        </div>
        {onNavigate && (
          <button
            className="rounded-lg p-1 text-(--color-fg-muted) hover:bg-(--color-panel-2) lg:hidden"
            onClick={onNavigate}
            aria-label={d.shell.closeMenu}
          >
            <X size={16} />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2.5 py-3">
        {NAV.map((item) => {
          const active = isActivePath(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.what(d)}
              onClick={onNavigate}
              className={cn(
                "group flex items-center gap-2.5 rounded-lg py-2 pr-2.5 text-[13px] font-medium transition-colors",
                item.child ? "ml-4 pl-2.5" : "pl-2.5",
                active ? "text-(--color-fg)" : "text-(--color-fg-muted) hover:bg-(--color-panel-2) hover:text-(--color-fg)",
              )}
              style={active ? { background: `color-mix(in srgb, ${item.color} 10%, var(--color-panel))` } : undefined}
            >
              <span
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors"
                style={{
                  background: active ? item.color : `color-mix(in srgb, ${item.color} 12%, var(--color-panel))`,
                  color: active ? "#fff" : item.color,
                }}
                aria-hidden
              >
                <Icon size={15} />
              </span>
              <span className="truncate">{item.label(d)}</span>
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-(--color-border) p-3">
        {/* Phone-only home for the theme control; the header owns it at sm+. */}
        <div className="mb-3 flex items-center justify-between gap-2 sm:hidden">
          <span className="text-[11px] font-medium text-(--color-fg-muted)">{d.theme.label}</span>
          <ThemeToggle />
        </div>
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-(--color-accent-soft) text-xs font-bold text-(--color-accent)">
            {admin.name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold">{admin.name}</div>
            <div className="truncate text-[10px] text-(--color-fg-faint)">
              {admin.login} · {admin.role}
            </div>
          </div>
          <button
            onClick={onLogout}
            title={d.shell.signOut}
            aria-label={d.shell.signOut}
            className="rounded-lg p-1.5 text-(--color-fg-muted) hover:bg-(--color-danger-soft) hover:text-(--color-danger)"
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>
    </>
  );
}

function Shell({ admin, children }: { admin: AdminIdentity; children: React.ReactNode }) {
  const { d } = useI18n();
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
      toast.error(d.common.error);
    }
  }

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* desktop rail — always docked at lg+ */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-(--color-border) bg-(--color-panel) lg:flex">
        <SidebarBody admin={admin} pathname={pathname} onLogout={logout} />
      </aside>

      {/* mobile drawer — mounted only while open, so no off-canvas transform race */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-(--color-scrim)" onClick={() => setMobileOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-(--color-border) bg-(--color-panel) shadow-2xl">
            <SidebarBody admin={admin} pathname={pathname} onNavigate={() => setMobileOpen(false)} onLogout={logout} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-(--color-border) bg-(--color-panel) px-4">
          <button
            className="rounded-lg p-1.5 text-(--color-fg-muted) hover:bg-(--color-panel-2) lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label={d.shell.openMenu}
          >
            <Menu size={18} />
          </button>

          {/* min-w-24 is load-bearing: the right-hand group is ml-auto, so
              without a floor this collapses to 0px on a narrow phone and the
              account switcher silently disappears. */}
          <div className="flex min-w-24 items-center gap-2">
            <span className="hidden text-xs text-(--color-fg-faint) sm:inline">{d.shell.workingOn}</span>
            <Select
              className="h-8 w-full min-w-0 max-w-56 text-xs"
              value={selectedId ?? ""}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={accounts.length === 0}
              aria-label={d.shell.workingOn}
            >
              {accounts.length === 0 && <option value="">{d.shell.noAccount}</option>}
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                  {a.isDemo ? ` (${d.shell.demo})` : ""}
                </option>
              ))}
            </Select>
          </div>

          <div className="ml-auto flex items-center gap-2.5">
            <MasterSwitchPill />
            {/* Below sm the header cannot hold this AND the account switcher —
                it moves into the drawer there (see SidebarBody). */}
            <ThemeToggle className="hidden sm:inline-flex" />
            <LanguageSwitcher compact />
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">{children}</main>
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

export { LanguageSwitcher };
