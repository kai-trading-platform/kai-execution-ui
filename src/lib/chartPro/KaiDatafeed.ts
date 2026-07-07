import type { KLineData } from 'klinecharts';
import type { Datafeed, DatafeedSubscribeCallback, Period, SymbolInfo } from '@klinecharts/pro';
import { fetchCandles } from '@/modules/copyTrading/hooks/useMarketCandles';
import { periodDurationMs } from './periods';

/**
 * Adapter entre el Datafeed que espera `@klinecharts/pro` y las fuentes de
 * datos que ya usa el terminal:
 *  - histórico → `fetchCandles(accountId, ticker, timeframe, count)` (REST MT5)
 *  - símbolos  → la lista de `useAccountSymbols` (inyectada como getter)
 *  - realtime  → el websocket de precios vive en React; el componente llama a
 *    `pushTick()` en cada tick y aquí construimos la vela en curso.
 *
 * Las dependencias se inyectan como getters para que el datafeed (una clase
 * plana, instanciada una vez) siempre vea el accountId/símbolos frescos sin
 * recrearse en cada render.
 */
export interface KaiDatafeedDeps {
  getAccountId: () => string | null | undefined;
  getSymbols: () => SymbolInfo[];
  subscribeSocket: (accountId: string, symbol: string) => void;
  unsubscribeSocket: (accountId: string, symbol: string) => void;
}

interface ActiveSub {
  period: Period;
  callback: DatafeedSubscribeCallback;
  lastBar: KLineData | null;
}

const HISTORY_COUNT = 20_000;

export class KaiDatafeed implements Datafeed {
  private readonly deps: KaiDatafeedDeps;
  private readonly subs = new Map<string, ActiveSub>(); // key: ticker (nombre raw del bróker)

  constructor(deps: KaiDatafeedDeps) {
    this.deps = deps;
  }

  async searchSymbols(search?: string): Promise<SymbolInfo[]> {
    const all = this.deps.getSymbols();
    const q = (search ?? '').trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (s) =>
        s.ticker.toLowerCase().includes(q) ||
        (s.shortName ?? '').toLowerCase().includes(q) ||
        (s.name ?? '').toLowerCase().includes(q),
    );
  }

  async getHistoryKLineData(symbol: SymbolInfo, period: Period): Promise<KLineData[]> {
    const accountId = this.deps.getAccountId();
    if (!accountId || !symbol?.ticker) return [];

    // Un blip de red al cargar hacía que fetchCandles fallara/volviera vacío →
    // el fork llama applyNewData([], false) y el chart queda con 1 sola vela.
    // Reintentamos con backoff para que un corte transitorio no vacíe el chart.
    let candles: Awaited<ReturnType<typeof fetchCandles>> = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        candles = await fetchCandles(accountId, symbol.ticker, period.text, HISTORY_COUNT);
      } catch {
        candles = [];
      }
      if (candles.length > 0) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    const data: KLineData[] = candles.map((c) => ({
      timestamp: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    // Semilla de la vela en curso para el bucketing de ticks.
    const sub = this.subs.get(symbol.ticker);
    if (sub) {
      sub.period = period;
      sub.lastBar = data.length ? data[data.length - 1] : null;
    }
    return data;
  }

  subscribe(symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback): void {
    if (!symbol?.ticker) return;
    this.subs.set(symbol.ticker, { period, callback, lastBar: null });
    const accountId = this.deps.getAccountId();
    if (accountId) this.deps.subscribeSocket(accountId, symbol.ticker);
  }

  unsubscribe(symbol: SymbolInfo): void {
    if (!symbol?.ticker) return;
    this.subs.delete(symbol.ticker);
    const accountId = this.deps.getAccountId();
    if (accountId) this.deps.unsubscribeSocket(accountId, symbol.ticker);
  }

  /**
   * Puente desde el websocket (React) hacia el chart: agrupa cada tick en la
   * vela del período actual y notifica al callback de klinecharts-pro.
   */
  pushTick(ticker: string, price: number, timeMs: number): void {
    const sub = this.subs.get(ticker);
    if (!sub || !Number.isFinite(price)) return;

    const durMs = periodDurationMs(sub.period);
    const bucket = Math.floor(timeMs / durMs) * durMs;
    const prev = sub.lastBar;

    const bar: KLineData =
      prev && prev.timestamp === bucket
        ? { ...prev, high: Math.max(prev.high, price), low: Math.min(prev.low, price), close: price }
        : { timestamp: bucket, open: price, high: price, low: price, close: price, volume: 0 };

    sub.lastBar = bar;
    sub.callback(bar);
  }
}
