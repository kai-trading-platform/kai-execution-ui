import { useEffect, useMemo, useRef } from 'react';
import { LineType } from 'klinecharts';
import { KLineChartPro } from '@klinecharts/pro';
import type { SymbolInfo } from '@klinecharts/pro';
import '@klinecharts/pro/dist/klinecharts-pro.css';

import { cn } from '@/lib/utils';
import { useAccountSymbols } from '@/hooks/useAccountSymbols';
import { useMarketSocket } from '@/contexts/MarketSocketContext';
import { formatSymbolDisplay } from '@/lib/symbolDisplay';
import { KaiDatafeed } from '@/lib/chartPro/KaiDatafeed';
import { CHART_PRO_PERIODS, periodForTimeframe } from '@/lib/chartPro/periods';

import type { CopyTradingPosition } from '@/modules/copyTrading/types';

interface KaiChartProProps {
  symbol?: string | null;
  accountId?: string | null;
  positions?: CopyTradingPosition[];
  timeframe?: string;
  timezone?: string;
  className?: string;
}

/**
 * Chart del terminal montando el widget `@klinecharts/pro`, que aporta la suite
 * ampliada de drawing tools + indicadores. Reutiliza las fuentes de datos del
 * terminal vía `KaiDatafeed` (histórico REST + ticks del websocket) y se maneja
 * detrás del flag `VITE_CHART_PRO` para no romper el chart actual.
 */
export function KaiChartPro({ symbol, accountId, positions, timeframe = '1h', timezone, className }: KaiChartProProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<KLineChartPro | null>(null);
  const datafeedRef = useRef<KaiDatafeed | null>(null);

  const { symbols: accountSymbols } = useAccountSymbols(accountId ?? undefined);
  const { ticks, subscribe, unsubscribe } = useMarketSocket();

  // AccountSymbol[] → SymbolInfo[], deduplicado por display (misma lógica que la
  // watchlist: `USTECm` y `USTEC_x100m` colapsan a "USTEC").
  const symbolInfos = useMemo<SymbolInfo[]>(() => {
    const byDisplay = new Map<string, SymbolInfo>();
    const isScaled = (name: string) => /_x\d+/i.test(name);
    for (const s of accountSymbols) {
      const display = formatSymbolDisplay(s.name);
      const existing = byDisplay.get(display);
      if (!existing || (isScaled(existing.ticker) && !isScaled(s.name))) {
        byDisplay.set(display, {
          ticker: s.name,
          shortName: display,
          name: s.description || display,
          pricePrecision: s.digits,
          type: s.category,
          market: s.category,
          priceCurrency: s.currency_profit,
        });
      }
    }
    return Array.from(byDisplay.values());
  }, [accountSymbols]);

  const currentSymbolInfo = useMemo<SymbolInfo | null>(() => {
    if (!symbol) return null;
    return (
      symbolInfos.find((s) => s.ticker === symbol) ?? {
        ticker: symbol,
        shortName: formatSymbolDisplay(symbol),
        name: formatSymbolDisplay(symbol),
      }
    );
  }, [symbol, symbolInfos]);

  // Refs frescas para que el datafeed (clase plana, creada una vez) siempre lea
  // valores actuales sin recrearse.
  const accountIdRef = useRef(accountId);
  const symbolInfosRef = useRef<SymbolInfo[]>([]);
  const subscribeRef = useRef(subscribe);
  const unsubscribeRef = useRef(unsubscribe);
  accountIdRef.current = accountId;
  symbolInfosRef.current = symbolInfos;
  subscribeRef.current = subscribe;
  unsubscribeRef.current = unsubscribe;

  if (!datafeedRef.current) {
    datafeedRef.current = new KaiDatafeed({
      getAccountId: () => accountIdRef.current,
      getSymbols: () => symbolInfosRef.current,
      subscribeSocket: (a, s) => subscribeRef.current(a, s),
      unsubscribeSocket: (a, s) => unsubscribeRef.current(a, s),
    });
  }

  // Crear el widget una sola vez, cuando hay contenedor + símbolo inicial.
  const canCreate = Boolean(currentSymbolInfo);
  useEffect(() => {
    if (chartRef.current || !containerRef.current || !datafeedRef.current || !currentSymbolInfo) return;
    chartRef.current = new KLineChartPro({
      container: containerRef.current,
      symbol: currentSymbolInfo,
      period: periodForTimeframe(timeframe),
      periods: CHART_PRO_PERIODS,
      datafeed: datafeedRef.current,
      theme: 'dark',
      // Pro trae zh-CN por defecto; forzamos inglés (no bundlea es-ES).
      locale: 'en-US',
      drawingBarVisible: true,
      mainIndicators: ['EMA'],
      timezone: timezone || undefined,
    });
    const container = containerRef.current;
    return () => {
      // 0.1.1 no expone dispose; al desmontar limpiamos el contenedor.
      if (container) container.replaceChildren();
      chartRef.current = null;
    };
    // Crear una vez cuando `canCreate` pasa a true. Los cambios posteriores de
    // símbolo/período/tz se aplican vía setSymbol/setPeriod/setTimezone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreate]);

  // Cambio de símbolo (o de cuenta → re-fetch con el nuevo accountId).
  useEffect(() => {
    if (!chartRef.current || !currentSymbolInfo) return;
    chartRef.current.setSymbol(currentSymbolInfo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSymbolInfo?.ticker, accountId]);

  // Cambio de timeframe desde el terminal.
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.setPeriod(periodForTimeframe(timeframe));
  }, [timeframe]);

  // Cambio de timezone.
  useEffect(() => {
    if (!chartRef.current || !timezone) return;
    chartRef.current.setTimezone(timezone);
  }, [timezone]);

  // Puente websocket → chart: cada tick del socket alimenta la vela en curso.
  // El datafeed ignora tickers sin suscripción activa, así que iterar todos es
  // seguro y cubre también símbolos abiertos desde el propio buscador de Pro.
  useEffect(() => {
    const acct = accountIdRef.current;
    if (!acct) return;
    const prefix = `${acct}::`;
    ticks.forEach((tick, key) => {
      if (!key.startsWith(prefix)) return;
      const ticker = key.slice(prefix.length);
      const price = Number.isFinite(tick.last) && tick.last > 0 ? tick.last : tick.bid;
      datafeedRef.current?.pushTick(ticker, price, Date.now());
    });
  }, [ticks]);

  // Dibuja entry / TP / SL de las posiciones del símbolo actual sobre el chart
  // interno de klinecharts (expuesto por nuestro fork vía getChart()). Read-only
  // por ahora (lock: true); el drag-para-editar TP/SL se agregará después.
  useEffect(() => {
    const pro = chartRef.current;
    const chart = pro?.getChart?.();
    if (!chart) return;
    chart.removeOverlay({ groupId: 'positions' });
    const symbolPositions = (positions ?? []).filter((p) => p.symbol === symbol);
    for (const pos of symbolPositions) {
      const line = (value: number, color: string) =>
        chart.createOverlay({
          name: 'horizontalStraightLine',
          groupId: 'positions',
          lock: true,
          points: [{ value }],
          styles: { line: { color, style: LineType.Dashed } },
        });
      if (Number.isFinite(pos.avgPrice)) line(pos.avgPrice, 'rgba(226,228,233,0.7)');
      if (pos.tp && pos.tp > 0) line(pos.tp, '#2ed68d');
      if (pos.sl && pos.sl > 0) line(pos.sl, '#ef5350');
    }
  }, [positions, symbol, currentSymbolInfo?.ticker, canCreate]);

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
