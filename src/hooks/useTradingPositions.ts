import { useQuery } from "@tanstack/react-query";
import { listTradingPositions } from "@/api/trading";

export const tradingPositionsQueryKey = (tradingAccountId?: string | null) =>
  ["trading", "accounts", tradingAccountId ?? "", "positions"] as const;

export function useTradingPositions(tradingAccountId?: string | null) {
  return useQuery({
    queryKey: tradingPositionsQueryKey(tradingAccountId),
    queryFn: () => listTradingPositions(String(tradingAccountId)),
    enabled: Boolean(tradingAccountId),
  });
}
