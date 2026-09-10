"use client";

import * as React from "react";
import { api } from "@/lib/client/api";

/** Selected Instagram account (tenant) — shared by every dashboard page. */

export interface AccountSummary {
  id: string;
  username: string;
  connectionMode: "INSTAGRAM_LOGIN" | "FACEBOOK_LOGIN";
  status: "CONNECTED" | "DISCONNECTED" | "ERROR";
  isDemo: boolean;
  adAccountId: string | null;
  webhookSubscribed: boolean;
  capabilities: Array<{ key: string; label: string; available: boolean; reason?: string }>;
}

interface AccountContextShape {
  accounts: AccountSummary[];
  selected: AccountSummary | null;
  selectedId: string | null;
  setSelectedId: (id: string) => void;
  reload: () => Promise<void>;
  loading: boolean;
}

const AccountContext = React.createContext<AccountContextShape | null>(null);

const STORAGE_KEY = "ig-selected-account";

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [accounts, setAccounts] = React.useState<AccountSummary[]>([]);
  const [selectedId, setSelectedIdState] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const reload = React.useCallback(async () => {
    try {
      const data = await api<{ accounts: AccountSummary[] }>("/api/instagram/accounts", { silent: true });
      setAccounts(data.accounts);
      setSelectedIdState((prev) => {
        const stored = prev ?? (typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null);
        if (stored && data.accounts.some((a) => a.id === stored)) return stored;
        return data.accounts[0]?.id ?? null;
      });
    } catch {
      /* toast handled globally for non-silent; here keep quiet on dashboard boot */
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const setSelectedId = React.useCallback((id: string) => {
    setSelectedIdState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* private mode */
    }
  }, []);

  const selected = accounts.find((a) => a.id === selectedId) ?? null;

  return (
    <AccountContext.Provider value={{ accounts, selected, selectedId, setSelectedId, reload, loading }}>
      {children}
    </AccountContext.Provider>
  );
}

export function useAccounts(): AccountContextShape {
  const ctx = React.useContext(AccountContext);
  if (!ctx) throw new Error("useAccounts must be used inside AccountProvider");
  return ctx;
}
