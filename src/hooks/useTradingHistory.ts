import { useQuery } from "@tanstack/react-query";
import { listTradingHistory } from "@/api/trading";

export const tradingHistoryQueryKey = (tradingAccountId?: string | null) =>
  ["trading", "accounts", tradingAccountId ?? "", "history"] as const;

export function useTradingHistory(tradingAccountId?: string | null) {
  return useQuery({
    queryKey: tradingHistoryQueryKey(tradingAccountId),
    queryFn: () => listTradingHistory(String(tradingAccountId)),
    enabled: Boolean(tradingAccountId),
    refetchInterval: 30_000,
  });
}
