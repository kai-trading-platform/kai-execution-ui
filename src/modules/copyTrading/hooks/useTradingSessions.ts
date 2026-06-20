import { useQuery } from "@tanstack/react-query";
import { listMt5Accounts } from "@/services/tradingConfig.service";

interface SessionAccount {
  id: string;
  accountName: string | null;
  providerAccountId: string | null;
  server: string | null;
  accountType: string | null;
  balanceUsd: number | null;
  equityUsd: number | null;
  margin: number | null;
  freeMargin: number | null;
  floatingPnl: number | null;
  connectionStatus: string;
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

async function fetchSessionsAccounts(): Promise<SessionAccount[]> {
  const accounts = await listMt5Accounts();
  if (!Array.isArray(accounts)) return [];

  return accounts.map((account) => ({
    id: account.id,
    accountName: account.account_name || account.mt5_account_id || account.id,
    providerAccountId: account.mt5_account_id || null,
    server: account.server || null,
    accountType: account.account_type || null,
    balanceUsd: toNullableNumber(account.balance),
    equityUsd: toNullableNumber(account.equity),
    margin: toNullableNumber(account.margin),
    freeMargin: toNullableNumber(account.free_margin),
    floatingPnl: toNullableNumber(account.floating_pnl),
    connectionStatus: account.connection_status || "disconnected",
  }));
}

export function useTradingSessions() {
  return useQuery({
    queryKey: ["trading-sessions"],
    queryFn: fetchSessionsAccounts,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
