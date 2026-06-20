import { useEffect, useState, useCallback, useMemo } from 'react';
import { nestAuthFetch } from '@/api/client';
import { AccountSymbol } from '@/types/market.types';

export interface UseAccountSymbolsResult {
  symbols: AccountSymbol[];
  groupedSymbols: Record<string, AccountSymbol[]>;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useAccountSymbols(accountId: string | null | undefined): UseAccountSymbolsResult {
  const [symbols, setSymbols] = useState<AccountSymbol[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchSymbols = useCallback(async () => {
    if (!accountId) {
      setSymbols([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      // The API endpoint in the controller is GET /mt5-accounts/:accountId/symbols
      const data = await nestAuthFetch<AccountSymbol[]>(`/api/mt5-accounts/${accountId}/symbols`);
      setSymbols(data || []);
    } catch (err) {
      console.error('Failed to fetch account symbols', err);
      setError(err instanceof Error ? err : new Error('Failed to fetch account symbols'));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    fetchSymbols();
  }, [fetchSymbols]);

  const groupedSymbols = useMemo(() => {
    const groups: Record<string, AccountSymbol[]> = {};
    for (const sym of symbols) {
      const cat = sym.category || 'Other';
      if (!groups[cat]) {
        groups[cat] = [];
      }
      groups[cat].push(sym);
    }
    return groups;
  }, [symbols]);

  return {
    symbols,
    groupedSymbols,
    loading,
    error,
    refetch: fetchSymbols,
  };
}
