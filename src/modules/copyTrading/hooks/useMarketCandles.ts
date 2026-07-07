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
  "2m": "M2",
  "3m": "M3",
  "4m": "M4",
  "5m": "M5",
  "6m": "M6",
  "10m": "M10",
  "12m": "M12",
  "15m": "M15",
  "20m": "M20",
  "30m": "M30",
  "1h": "H1",
  "2h": "H2",
  "3h": "H3",
  "4h": "H4",
  "6h": "H6",
  "8h": "H8",
  "12h": "H12",
  D: "D1",
  W: "W1",
  M: "MN1",
};

type RawCandle = {
  timestamp?: number;
  time?: number;
  open: number | string;
  high: number | string;
  low: number | string;
  close: number | string;
  volume?: number | string;
};

// MT5 no siempre devuelve histórico para los TFs NO estándar (M10, H2): son
// sintéticos y dependen del M1 base cargado, así que a veces vienen VACÍOS y el
// chart quedaba sin velas en 10m / 2h. Fallback: agregar desde el TF base
// estándar que MT5 siempre tiene (M5→10m, H1→2h).
const AGG_FALLBACK: Record<string, { base: string; ratio: number; bucketMs: number }> = {
  "10m": { base: "M5", ratio: 2, bucketMs: 10 * 60_000 },
  "2h": { base: "H1", ratio: 2, bucketMs: 2 * 60 * 60_000 },
};

// Agrupa velas de un TF base en buckets de `bucketMs` (open=primera, close=última,
// high=máx, low=mín, volume=suma). `src` viene ordenado ascendente.
function aggregateCandles(src: MarketCandle[], bucketMs: number): MarketCandle[] {
  const buckets = new Map<number, MarketCandle>();
  for (const c of src) {
    const b = Math.floor(c.time / bucketMs) * bucketMs;
    const ex = buckets.get(b);
    if (!ex) {
      buckets.set(b, { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume ?? 0 });
    } else {
      ex.high = Math.max(ex.high, c.high);
      ex.low = Math.min(ex.low, c.low);
      ex.close = c.close;
      ex.volume = (ex.volume ?? 0) + (c.volume ?? 0);
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time);
}

// Fetch + normalización de un TF nativo de MT5, con fallback de count (MT5
// devuelve VACÍO si se le piden más velas de las que tiene, en vez de clamplear).
async function fetchRawTf(
  accountId: string,
  symbol: string,
  mt5Tf: string,
  limit: number,
): Promise<MarketCandle[]> {
  // MT5 devuelve VACÍO si se le piden MÁS velas de las que tiene (no clampea).
  // El fallback prueba counts decrecientes y usa el primero que trae datos. Los
  // TFs macro (W/MN e incluso D en símbolos nuevos) tienen POCAS barras, así que
  // el piso debe ser bajo (hasta 5) — si no, todo ≥500 volvía vacío y el chart
  // quedaba con 1 sola vela (solo la viva del tick).
  const candidates = Array.from(
    new Set(
      [limit, 10000, 5000, 3000, 2000, 1000, 500, 300, 200, 100, 50, 25, 10, 5].filter(
        (n) => n > 0 && n <= limit,
      ),
    ),
  );
  let candles: RawCandle[] = [];
  for (const count of candidates) {
    candles = await nestAuthFetch<RawCandle[]>(
      `/api/mt5-accounts/${accountId}/rates/${encodeURIComponent(symbol)}?timeframe=${mt5Tf}&count=${count}`,
    );
    if (candles && candles.length > 0) break;
  }
  if (!candles || candles.length === 0) return [];

  const byTime = new Map<number, MarketCandle>();
  for (const c of candles) {
    const rawTime = c.timestamp ?? c.time;
    const numericTime = Number(rawTime);
    if (!Number.isFinite(numericTime)) continue;
    const timeMs = numericTime > 1e12 ? numericTime : numericTime * 1000;
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    if (![open, high, low, close].every(Number.isFinite)) continue;
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

export async function fetchCandles(
  accountId: string,
  symbol: string,
  timeframe: string,
  limit: number = 300
): Promise<MarketCandle[]> {
  const tf = TIMEFRAME_MAP[timeframe] ?? timeframe;
  let out = await fetchRawTf(accountId, symbol, tf, limit);

  // Si el TF no estándar (10m/2h) vino vacío, agregamos desde el TF base.
  if (out.length === 0 && AGG_FALLBACK[timeframe]) {
    const { base, ratio, bucketMs } = AGG_FALLBACK[timeframe];
    const baseCandles = await fetchRawTf(accountId, symbol, base, Math.min(limit * ratio, 20_000));
    if (baseCandles.length > 0) out = aggregateCandles(baseCandles, bucketMs);
  }

  return out;
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
