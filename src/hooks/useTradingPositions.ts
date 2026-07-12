import { useQuery } from "@tanstack/react-query";
import { listTradingPositions } from "@/api/trading";

export const tradingPositionsQueryKey = (tradingAccountId?: string | null) =>
  ["trading", "accounts", tradingAccountId ?? "", "positions"] as const;

export function useTradingPositions(tradingAccountId?: string | null) {
  return useQuery({
    queryKey: tradingPositionsQueryKey(tradingAccountId),
    queryFn: () => listTradingPositions(String(tradingAccountId)),
    enabled: Boolean(tradingAccountId),
    // PnL flotante en (casi) tiempo real: el backend recalcula el PnL con el
    // precio vivo (sim ~2.5s vía Yahoo; MT5 vía bridge), así la tarjeta de
    // posiciones deja de quedar congelada. Antes no reconsultaba nunca.
    refetchInterval: 2500,
    refetchIntervalInBackground: false,
  });
}
