import { useEffect } from 'react';
import { useMarketSocket, type LiveTick } from '@/contexts/MarketSocketContext';

export interface UseMarketDataResult {
  tick: LiveTick | null;
  isConnected: boolean;
}

export function useMarketData(
  accountId: string | null | undefined,
  symbol: string | null | undefined,
): UseMarketDataResult {
  const { ticks, subscribe, unsubscribe, isConnected } = useMarketSocket();

  useEffect(() => {
    if (!isConnected || !accountId || !symbol) {
      return;
    }
    subscribe(accountId, symbol);
    return () => {
      unsubscribe(accountId, symbol);
    };
  }, [isConnected, accountId, symbol, subscribe, unsubscribe]);

  const tick = accountId && symbol ? ticks.get(`${accountId}::${symbol}`) ?? null : null;

  return { tick, isConnected };
}
