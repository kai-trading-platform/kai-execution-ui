/**
 * TradingView Advanced Charts — MT5 Datafeed adapter.
 *
 * This implements the (subset of the) Datafeed API the TradingView Charting
 * Library calls, backed by OUR existing data sources:
 *   - History  → GET /api/mt5-accounts/:accountId/rates/:symbol (via fetchCandles)
 *   - Realtime → the market socket 'tick' events (aggregated into the live bar)
 *
 * It deliberately does NOT import from 'charting_library' so the project keeps
 * building before the (licensed) library is dropped into /public. When the
 * library lands, this object satisfies `IBasicDataFeed` as-is — see README.md.
 */
import { fetchCandles } from "@/modules/copyTrading/hooks/useMarketCandles";
import { formatSymbolDisplay } from "@/lib/symbolDisplay";

// ── Minimal local mirrors of the library's types (so we don't need its d.ts) ──
interface TickEvent {
  accountId: string;
  symbol: string;
  tick: { bid: number; ask: number; last: number };
}
interface SocketLike {
  on: (event: "tick", cb: (data: TickEvent) => void) => void;
  off: (event: "tick", cb: (data: TickEvent) => void) => void;
}
export interface DatafeedDeps {
  accountId: string;
  socket: SocketLike | null;
  subscribe: (accountId: string, symbol: string) => void;
  unsubscribe: (accountId: string, symbol: string) => void;
}

interface Bar {
  time: number; // milliseconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}
interface PeriodParams {
  from: number; // seconds
  to: number; // seconds
  countBack: number;
  firstDataRequest: boolean;
}
interface ResolveSymbolInfo {
  ticker?: string;
  name: string;
}

// TradingView resolution ("1","60","1D"…) → our MT5 timeframe code. fetchCandles
// passes unknown keys straight through to the bridge, so MT5 codes work directly.
const RES_TO_MT5: Record<string, string> = {
  "1": "M1",
  "5": "M5",
  "10": "M10",
  "15": "M15",
  "30": "M30",
  "60": "H1",
  "120": "H2",
  "240": "H4",
  "1D": "D1",
  D: "D1",
  "1W": "W1",
  W: "W1",
  "1M": "MN1",
  M: "MN1",
};
const RES_TO_SECONDS: Record<string, number> = {
  "1": 60,
  "5": 300,
  "10": 600,
  "15": 900,
  "30": 1800,
  "60": 3600,
  "120": 7200,
  "240": 14400,
  "1D": 86400,
  D: 86400,
  "1W": 604800,
  W: 604800,
  "1M": 2592000,
  M: 2592000,
};
const SUPPORTED_RESOLUTIONS = ["1", "5", "10", "15", "30", "60", "120", "240", "1D", "1W", "1M"];

export function createMt5Datafeed({ accountId, socket, subscribe, unsubscribe }: DatafeedDeps) {
  // listenerGuid → { handler, symbol } so we can detach on unsubscribe.
  const realtime = new Map<string, { handler: (d: TickEvent) => void; symbol: string }>();
  // listenerGuid → current (still-forming) bar, to aggregate ticks.
  const lastBars = new Map<string, Bar>();

  return {
    onReady(callback: (config: { supported_resolutions: string[]; supports_time: boolean; supports_marks: boolean; supports_timescale_marks: boolean }) => void) {
      // The library requires this to be async.
      setTimeout(
        () =>
          callback({
            supported_resolutions: SUPPORTED_RESOLUTIONS,
            supports_time: true,
            supports_marks: false,
            supports_timescale_marks: false,
          }),
        0,
      );
    },

    // We don't expose a search UI through the library (Kai has its own watchlist
    // + market tabs), so return nothing.
    searchSymbols(
      _userInput: string,
      _exchange: string,
      _symbolType: string,
      onResult: (items: unknown[]) => void,
    ) {
      onResult([]);
    },

    async resolveSymbol(
      symbolName: string,
      onResolve: (info: Record<string, unknown>) => void,
      onError: (reason: string) => void,
    ) {
      try {
        // Infer decimals from a recent price (mirrors the trade panel: <20 → 5dp).
        const recent = await fetchCandles(accountId, symbolName, "M1", 1);
        const px = recent[recent.length - 1]?.close ?? 1;
        const decimals = px >= 20 ? 2 : 5;
        onResolve({
          ticker: symbolName,
          name: formatSymbolDisplay(symbolName),
          full_name: formatSymbolDisplay(symbolName),
          description: formatSymbolDisplay(symbolName),
          type: "crypto",
          // 24x7 keeps the library from hiding bars across weekends. Forex
          // sessions could be modeled per-symbol later if desired.
          session: "24x7",
          timezone: "Etc/UTC",
          exchange: "MT5",
          listed_exchange: "MT5",
          format: "price",
          minmov: 1,
          pricescale: Math.pow(10, decimals),
          has_intraday: true,
          has_daily: true,
          has_weekly_and_monthly: true,
          supported_resolutions: SUPPORTED_RESOLUTIONS,
          volume_precision: 2,
          data_status: "streaming",
        });
      } catch (e) {
        onError(e instanceof Error ? e.message : "resolve_error");
      }
    },

    async getBars(
      symbolInfo: ResolveSymbolInfo,
      resolution: string,
      periodParams: PeriodParams,
      onResult: (bars: Bar[], meta: { noData: boolean }) => void,
      onError: (reason: string) => void,
    ) {
      const { from, to, countBack, firstDataRequest } = periodParams;
      const mt5tf = RES_TO_MT5[resolution] ?? "H1";
      const symbol = symbolInfo.ticker ?? symbolInfo.name;
      // Count-based backend: request enough to cover the window. Older pages
      // (firstDataRequest=false) widen the window to reach further back.
      const base = Math.max(countBack || 300, 2000);
      const count = Math.min(100000, firstDataRequest ? base : base * 5);
      try {
        const candles = await fetchCandles(accountId, symbol, mt5tf, count);
        const bars: Bar[] = candles
          .filter((c) => {
            const tSec = Math.floor(c.time / 1000);
            return tSec >= from && tSec < to;
          })
          .map((c) => ({
            time: c.time, // library expects milliseconds
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume ?? 0,
          }));
        onResult(bars, { noData: bars.length === 0 });
      } catch (e) {
        onError(e instanceof Error ? e.message : "get_bars_error");
      }
    },

    subscribeBars(
      symbolInfo: ResolveSymbolInfo,
      resolution: string,
      onTick: (bar: Bar) => void,
      listenerGuid: string,
    ) {
      const symbol = symbolInfo.ticker ?? symbolInfo.name;
      const resSec = RES_TO_SECONDS[resolution] ?? 3600;
      subscribe(accountId, symbol);
      const handler = (data: TickEvent) => {
        if (data.accountId !== accountId || data.symbol !== symbol) return;
        const price = data.tick.last || data.tick.bid;
        if (!(price > 0)) return;
        const barStartMs = Math.floor(Date.now() / 1000 / resSec) * resSec * 1000;
        const prev = lastBars.get(listenerGuid);
        if (prev && prev.time === barStartMs) {
          const next: Bar = {
            ...prev,
            high: Math.max(prev.high, price),
            low: Math.min(prev.low, price),
            close: price,
          };
          lastBars.set(listenerGuid, next);
          onTick(next);
        } else {
          const bar: Bar = { time: barStartMs, open: price, high: price, low: price, close: price, volume: 0 };
          lastBars.set(listenerGuid, bar);
          onTick(bar);
        }
      };
      socket?.on("tick", handler);
      realtime.set(listenerGuid, { handler, symbol });
    },

    unsubscribeBars(listenerGuid: string) {
      const sub = realtime.get(listenerGuid);
      if (sub) {
        socket?.off("tick", sub.handler);
        unsubscribe(accountId, sub.symbol);
        realtime.delete(listenerGuid);
        lastBars.delete(listenerGuid);
      }
    },
  };
}

export type Mt5Datafeed = ReturnType<typeof createMt5Datafeed>;
