import { useQuery } from "@tanstack/react-query";
import { nestAuthFetch } from "@/api/client";

export interface MarketCandle {
  time: number; // Unix timestamp in milliseconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

const TIMEFRAME_MAP: Record<string, string> = {
  "1m": "M1",
  "5m": "M5",
  "10m": "M10",
  "15m": "M15",
  "30m": "M30",
  "1h": "H1",
  "2h": "H2",
  "4h": "H4",
  D: "D1",
  W: "W1",
  M: "MN1",
};

export async function fetchCandles(
  accountId: string,
  symbol: string,
  timeframe: string,
  limit: number = 300
): Promise<MarketCandle[]> {
  const tf = TIMEFRAME_MAP[timeframe] ?? timeframe;

  type RawCandle = {
    timestamp?: number;
    time?: number;
    open: number | string;
    high: number | string;
    low: number | string;
    close: number | string;
    volume?: number | string;
  };

  // MT5 returns an EMPTY array when asked for MORE candles than it has on a
  // timeframe (e.g. 20000 on D1 = 54 years), instead of clamping. So try the
  // requested count first and fall back to progressively smaller ones until we
  // get data — this maximizes history per timeframe (1m gets weeks, D1 gets all
  // available years).
  const candidates = Array.from(
    new Set([limit, 10000, 5000, 3000, 2000, 1000, 500].filter((n) => n > 0 && n <= limit)),
  );
  let candles: RawCandle[] = [];
  for (const count of candidates) {
    candles = await nestAuthFetch<RawCandle[]>(
      `/api/mt5-accounts/${accountId}/rates/${encodeURIComponent(symbol)}?timeframe=${tf}&count=${count}`,
    );
    if (candles && candles.length > 0) break;
  }

  if (!candles || candles.length === 0) {
    return [];
  }

  const byTime = new Map<number, MarketCandle>();

  for (const c of candles) {
    const rawTime = c.timestamp ?? c.time;
    const numericTime = Number(rawTime);
    if (!Number.isFinite(numericTime)) {
      continue;
    }

    const timeMs = numericTime > 1e12 ? numericTime : numericTime * 1000;
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    if (![open, high, low, close].every(Number.isFinite)) {
      continue;
    }

    const volume = c.volume != null ? Number(c.volume) : undefined;

    byTime.set(timeMs, {
      time: timeMs,
      open,
      high,
      low,
      close,
      volume: volume != null && Number.isFinite(volume) ? volume : undefined,
    });
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export function useMarketCandles(
  accountId: string | null | undefined,
  symbol: string | null | undefined,
  timeframe: string,
  limit: number = 300
) {
  return useQuery({
    queryKey: ["market-candles", accountId, symbol, timeframe, limit],
    queryFn: () => {
      if (!accountId || !symbol) throw new Error("Missing accountId or symbol");
      return fetchCandles(accountId, symbol, timeframe, limit);
    },
    enabled: Boolean(accountId && symbol),
    staleTime: 10_000,
    refetchInterval: 30_000,
    retry: false,
  });
}
