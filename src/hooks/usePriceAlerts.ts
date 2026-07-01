import { useCallback, useEffect, useState } from "react";

export interface PriceAlert {
  id: string;
  symbol: string;
  target: number;
  /** "up" => fire when price >= target; "down" => fire when price <= target. */
  direction: "up" | "down";
  createdAt: number;
}

export interface TriggeredAlert extends PriceAlert {
  price: number;
  triggeredAt: number;
}

interface PersistShape {
  alerts: PriceAlert[];
  triggered: TriggeredAlert[];
  unread: number;
}

const STORAGE_KEY = "kai:price-alerts";

function load(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PersistShape;
  } catch {
    /* ignore */
  }
  return { alerts: [], triggered: [], unread: 0 };
}

/**
 * Client-side price alerts: the user sets "notify me when SYMBOL reaches PRICE".
 * Direction is inferred from the current price at creation time. State persists
 * in localStorage. Triggering is driven by the caller (it owns the live ticks).
 */
export function usePriceAlerts() {
  const [state, setState] = useState<PersistShape>(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* ignore quota */
    }
  }, [state]);

  const addAlert = useCallback((symbol: string, target: number, currentPrice: number) => {
    if (!symbol || !Number.isFinite(target) || target <= 0) return;
    const direction: "up" | "down" = target >= currentPrice ? "up" : "down";
    const alert: PriceAlert = {
      id: crypto.randomUUID(),
      symbol,
      target,
      direction,
      createdAt: Date.now(),
    };
    setState((s) => ({ ...s, alerts: [alert, ...s.alerts] }));
  }, []);

  const removeAlert = useCallback((id: string) => {
    setState((s) => ({ ...s, alerts: s.alerts.filter((a) => a.id !== id) }));
  }, []);

  const triggerAlert = useCallback((alert: PriceAlert, price: number) => {
    setState((s) => {
      // Guard against double-fire if it's already gone from the active list.
      if (!s.alerts.some((a) => a.id === alert.id)) return s;
      const t: TriggeredAlert = { ...alert, price, triggeredAt: Date.now() };
      return {
        alerts: s.alerts.filter((a) => a.id !== alert.id),
        triggered: [t, ...s.triggered].slice(0, 50),
        unread: s.unread + 1,
      };
    });
  }, []);

  const markRead = useCallback(() => {
    setState((s) => (s.unread === 0 ? s : { ...s, unread: 0 }));
  }, []);

  const clearTriggered = useCallback(() => {
    setState((s) => ({ ...s, triggered: [], unread: 0 }));
  }, []);

  return {
    alerts: state.alerts,
    triggered: state.triggered,
    unread: state.unread,
    addAlert,
    removeAlert,
    triggerAlert,
    markRead,
    clearTriggered,
  };
}
