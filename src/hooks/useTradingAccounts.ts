import { useQuery } from "@tanstack/react-query";
import { listTradingAccounts } from "@/api/trading";

export const TRADING_ACCOUNTS_QUERY_KEY = ["trading", "accounts"] as const;

export function useTradingAccounts() {
  return useQuery({
    queryKey: TRADING_ACCOUNTS_QUERY_KEY,
    queryFn: listTradingAccounts,
  });
}
