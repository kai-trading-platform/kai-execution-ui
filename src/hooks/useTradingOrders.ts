import { useQuery } from "@tanstack/react-query";
import { listTradingOrders } from "@/api/trading";

export const tradingOrdersQueryKey = (tradingAccountId?: string | null) =>
  ["trading", "accounts", tradingAccountId ?? "", "orders"] as const;

export function useTradingOrders(tradingAccountId?: string | null) {
  return useQuery({
    queryKey: tradingOrdersQueryKey(tradingAccountId),
    queryFn: () => listTradingOrders(String(tradingAccountId)),
    enabled: Boolean(tradingAccountId),
    refetchInterval: 15_000,
  });
}
