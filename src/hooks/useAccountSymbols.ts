import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { nestAuthFetch } from '@/api/client';
import { AccountSymbol } from '@/types/market.types';

export interface UseAccountSymbolsResult {
  symbols: AccountSymbol[];
  groupedSymbols: Record<string, AccountSymbol[]>;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  /**
   * Account id the current `symbols` were fetched FOR. While switching
   * accounts, `symbols` briefly holds the PREVIOUS account's catalog (it is
   * only replaced when the new fetch resolves), so consumers that validate a
   * selection against the catalog must check `loadedForAccountId === accountId`
   * before trusting it — otherwise they'd prune valid symbols against a stale
   * list. Stays on the previous id if the new fetch errors (catalog is stale).
   */
  loadedForAccountId: string | null;
}

export function useAccountSymbols(accountId: string | null | undefined): UseAccountSymbolsResult {
  const [symbols, setSymbols] = useState<AccountSymbol[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadedForAccountId, setLoadedForAccountId] = useState<string | null>(null);
  // Generación del fetch en curso (ver fetchSymbols): invalida retries viejos.
  const fetchGenerationRef = useRef(0);

  const fetchSymbols = useCallback(async () => {
    if (!accountId) {
      setSymbols([]);
      setLoadedForAccountId(null);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    // Reintentos con backoff: este fetch corre UNA vez por cuenta y sin él no
    // hay símbolos → el chart nunca se crea y "Cargando velas" se queda pegado
    // hasta refrescar. Un blip transitorio (la carrera del 401 al hidratar el
    // token en el primer load, red, backend reiniciando) no debe dejar el
    // terminal muerto. El guard de generación evita que un retry tardío de una
    // cuenta anterior pise los símbolos de la cuenta actual.
    const generation = ++fetchGenerationRef.current;
    const isStale = () => fetchGenerationRef.current !== generation;
    const RETRIES = 3;
    try {
      let lastErr: unknown = null;
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
        }
        if (isStale()) return;
        try {
          // The API endpoint in the controller is GET /mt5-accounts/:accountId/symbols
          const data = await nestAuthFetch<AccountSymbol[]>(`/api/mt5-accounts/${accountId}/symbols`);
          if (isStale()) return;
          setSymbols(data || []);
          setLoadedForAccountId(accountId);
          return;
        } catch (err) {
          lastErr = err;
        }
      }
      if (isStale()) return;
      console.error('Failed to fetch account symbols', lastErr);
      setError(lastErr instanceof Error ? lastErr : new Error('Failed to fetch account symbols'));
    } finally {
      if (!isStale()) setLoading(false);
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
    loadedForAccountId,
  };
}
