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
  /** Ticker actualmente seleccionado — para descartar respuestas TARDÍAS de un
   * símbolo anterior (cambiar de mercado rápido "bugueaba" el chart). */
  getCurrentTicker?: () => string | null | undefined;
  subscribeSocket: (accountId: string, symbol: string) => void;
  unsubscribeSocket: (accountId: string, symbol: string) => void;
  // Se dispara cada vez que getHistoryKLineData termina (con el nº de velas
  // devueltas). El overlay de "Cargando velas…" del chart lo usa para no dejar
  // ver el estado vacío ("bolsa") mientras se trae el histórico.
  onHistoryLoaded?: (count: number) => void;
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
  // Vela más ANTIGUA ya servida por (ticker|período). El backend solo sirve las
  // últimas N velas (ignora el rango pedido), así que cuando klinecharts-pro pagina
  // (load-more, scroll a la izquierda) pidiendo velas más viejas que esto, NO hay
  // histórico que dar: re-servir las mismas hacía que el fork las PREPENDARA →
  // chart duplicado (Bug B). Guardamos el borde para responder [] a esas peticiones.
  private readonly earliestServed = new Map<string, number>();

  // Coalescencia de peticiones en vuelo: al montar, el chart pide el histórico
  // y —por la hidratación de preferencias desde BD que re-fija el símbolo— se
  // disparaba una SEGUNDA petición idéntica (20k velas, ~3,6 s c/u = ~6 s de
  // "Cargando velas"). Compartimos la MISMA promesa mientras esté en vuelo para
  // una clave (cuenta|ticker|tf|count|around) → una sola llamada HTTP. Se limpia al
  // resolverse, así recargas posteriores vuelven a pedir fresco.
  private readonly inFlight = new Map<string, Promise<Awaited<ReturnType<typeof fetchCandles>>>>();
  // Doble clic en una ejecutada: el siguiente getHistoryKLineData pide velas
  // centradas en ese timestamp (el store tiene historia; las últimas N no).
  private focusAroundMs: number | null = null;

  constructor(deps: KaiDatafeedDeps) {
    this.deps = deps;
  }

  setFocusAround(aroundMs: number | null): void {
    this.focusAroundMs =
      aroundMs != null && Number.isFinite(aroundMs) && aroundMs > 0
        ? Math.floor(aroundMs)
        : null;
    if (this.focusAroundMs != null) this.earliestServed.clear();
  }

  private coalescedFetch(
    accountId: string,
    ticker: string,
    timeframe: string,
    count: number,
    aroundMs?: number,
  ): Promise<Awaited<ReturnType<typeof fetchCandles>>> {
    const k = `${accountId}|${ticker}|${timeframe}|${count}|${aroundMs ?? 0}`;
    const existing = this.inFlight.get(k);
    if (existing) return existing;
    const p = fetchCandles(accountId, ticker, timeframe, count, aroundMs).finally(() => {
      this.inFlight.delete(k);
    });
    this.inFlight.set(k, p);
    return p;
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

  async getHistoryKLineData(
    symbol: SymbolInfo,
    period: Period,
    from?: number,
    to?: number,
  ): Promise<KLineData[]> {
    const accountId = this.deps.getAccountId();
    if (!accountId || !symbol?.ticker) {
      this.deps.onHistoryLoaded?.(0);
      return [];
    }

    // LOAD-MORE (paginación): klinecharts-pro llama esto al hacer scroll a la
    // izquierda pidiendo velas ANTERIORES a `to`. El backend solo sirve las últimas
    // N (ignora el rango) → re-servirlas hacía que el fork las PREPENDARA y el mismo
    // tramo se repitiera (Bug B: eje de tiempo desordenado). Si ya servimos y piden
    // más viejo que nuestro borde, no hay histórico → []. El load inicial y el
    // heal-reload (llaman sin `to`, o con to ≈ ahora > borde) pasan normal.
    const key = `${symbol.ticker}|${period.text}`;
    const earliest = this.earliestServed.get(key);
    if (
      earliest !== undefined &&
      Number.isFinite(to) &&
      (to as number) <= earliest
    ) {
      this.deps.onHistoryLoaded?.(0);
      return [];
    }

    // Un blip de red al cargar hacía que fetchCandles fallara/volviera vacío →
    // el fork llama applyNewData([], false) y el chart queda con 1 sola vela.
    // Reintentamos con backoff para que un corte transitorio no vacíe el chart.
    let candles: Awaited<ReturnType<typeof fetchCandles>> = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        candles = await this.coalescedFetch(
          accountId,
          symbol.ticker,
          period.text,
          HISTORY_COUNT,
          this.focusAroundMs ?? undefined,
        );
      } catch {
        candles = [];
      }
      // >1: una respuesta de 0 ó 1 vela deja el chart "en blanco/1 vela"; se
      // reintenta (blip de red o fuente aún fría) para no forzar al usuario a
      // togglear el TF. Un símbolo con ≤1 vela real igual sale tras los 3 intentos.
      if (candles.length > 1) break;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    // Cambio rápido de símbolo: si mientras bajaba el histórico el usuario ya
    // se movió a OTRO símbolo, esta respuesta es vieja — descartarla evita que
    // las velas del símbolo anterior se pinten sobre el nuevo (bug reportado).
    const currentNow = this.deps.getCurrentTicker?.();
    if (currentNow && currentNow !== symbol.ticker) {
      this.deps.onHistoryLoaded?.(0);
      return [];
    }

    const data: KLineData[] = candles.map((c) => ({
      timestamp: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }));

    // Registra el borde (vela más antigua servida) para responder [] a futuros
    // load-more más viejos que esto (ver guard arriba). `data` viene ascendente.
    if (data.length) {
      this.earliestServed.set(key, data[0].timestamp);
    }

    // Semilla de la vela en curso para el bucketing de ticks.
    const sub = this.subs.get(symbol.ticker);
    if (sub) {
      sub.period = period;
      sub.lastBar = data.length ? data[data.length - 1] : null;
    }
    this.deps.onHistoryLoaded?.(data.length);
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
