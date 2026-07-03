import { useCallback, useEffect, useMemo, useRef } from 'react';
import { LineType } from 'klinecharts';
import type { Overlay, OverlayCreate } from 'klinecharts';
import { KLineChartPro } from '@klinecharts/pro';
import type { SymbolInfo, Period } from '@klinecharts/pro';
import '@klinecharts/pro/dist/klinecharts-pro.css';

import { cn } from '@/lib/utils';
import { useAccountSymbols } from '@/hooks/useAccountSymbols';
import { useMarketSocket } from '@/contexts/MarketSocketContext';
import { formatSymbolDisplay } from '@/lib/symbolDisplay';
import { KaiDatafeed } from '@/lib/chartPro/KaiDatafeed';
import { CHART_PRO_PERIODS, periodForTimeframe } from '@/lib/chartPro/periods';
import { useChartDrawings, type SavedDrawing } from '@/hooks/useChartDrawings';

/**
 * klinecharts espera una IANA válida ("America/New_York"). Nuestro setting usa el
 * sentinel "local" (y podría venir vacío) → klinecharts tira "Timezone is error!!!"
 * y, si pasáramos undefined, el fork defaultea a 'Asia/Shanghai'. Resolvemos
 * "local"/vacío a la IANA real del navegador.
 */
function resolveTimezone(tz?: string): string {
  if (!tz || tz === 'local') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
  return tz;
}

import type { CopyTradingPosition } from '@/modules/copyTrading/types';

const DRAWINGS_GROUP = 'drawing_tools';
const POSITIONS_GROUP = 'positions';

interface KaiChartProProps {
  symbol?: string | null;
  accountId?: string | null;
  positions?: CopyTradingPosition[];
  timeframe?: string;
  timezone?: string;
  className?: string;
  // Mostrar/ocultar líneas de entrada y TP/SL (ajustes del terminal).
  showPositions?: boolean;
  showTpSl?: boolean;
  // El buscador interno de Pro cambió el símbolo → que el terminal lo siga.
  onSymbolChange?: (ticker: string) => void;
  // La PeriodBar interna cambió el timeframe → reflejarlo en el terminal.
  onPeriodChange?: (timeframe: string) => void;
}

/**
 * Chart del terminal montando el widget `@klinecharts/pro`, que aporta la suite
 * ampliada de drawing tools + indicadores. Reutiliza las fuentes de datos del
 * terminal vía `KaiDatafeed` (histórico REST + ticks del websocket) y se maneja
 * detrás del flag `VITE_CHART_PRO` para no romper el chart actual.
 */
export function KaiChartPro({
  symbol,
  accountId,
  positions,
  timeframe = '1h',
  timezone,
  className,
  showPositions = true,
  showTpSl = true,
  onSymbolChange,
  onPeriodChange,
}: KaiChartProProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<KLineChartPro | null>(null);
  const datafeedRef = useRef<KaiDatafeed | null>(null);

  const { symbols: accountSymbols } = useAccountSymbols(accountId ?? undefined);
  const { ticks, subscribe, unsubscribe } = useMarketSocket();
  const { getDrawings, saveDrawing, removeDrawing } = useChartDrawings();

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

  // El chart se crea una sola vez; sus callbacks leen props/estado frescos vía refs.
  const symbolRef = useRef<string | null | undefined>(symbol);
  symbolRef.current = symbol;
  const onSymbolChangeRef = useRef(onSymbolChange);
  onSymbolChangeRef.current = onSymbolChange;
  const onPeriodChangeRef = useRef(onPeriodChange);
  onPeriodChangeRef.current = onPeriodChange;
  const getDrawingsRef = useRef(getDrawings);
  getDrawingsRef.current = getDrawings;
  const saveDrawingRef = useRef(saveDrawing);
  saveDrawingRef.current = saveDrawing;
  const removeDrawingRef = useRef(removeDrawing);
  removeDrawingRef.current = removeDrawing;

  // Guardia: durante la rehidratación limpiamos+recreamos overlays y NO queremos
  // que esos removes/creates programáticos se persistan (borrarían el símbolo
  // recién seleccionado).
  const rehydratingRef = useRef(false);

  // Persistencia central: toda alta/movimiento/borrado de un overlay de dibujo
  // pasa por aquí (tanto los creados desde la DrawingBar nativa vía onOverlayEvent
  // del fork, como los rehidratados que llevan sus propios callbacks).
  const persist = useCallback((type: 'created' | 'updated' | 'removed', overlay: Overlay) => {
    if (rehydratingRef.current) return;
    if (overlay.groupId !== DRAWINGS_GROUP) return;
    const sym = symbolRef.current;
    if (!sym) return;
    if (type === 'removed') removeDrawingRef.current(sym, overlay.id);
    else saveDrawingRef.current(sym, overlay);
  }, []);

  // SavedDrawing → OverlayCreate re-adjuntando los callbacks de persistencia para
  // que mover/borrar un dibujo rehidratado siga guardándose.
  const overlayFromSaved = useCallback(
    (d: SavedDrawing): OverlayCreate => ({
      id: d.id,
      groupId: DRAWINGS_GROUP,
      name: d.name,
      points: d.points,
      extendData: d.extendData,
      styles: d.styles,
      lock: d.lock,
      visible: d.visible,
      mode: d.mode,
      onPressedMoveEnd: (event) => {
        persist('updated', event.overlay);
        return false;
      },
      onRemoved: (event) => {
        persist('removed', event.overlay);
        return false;
      },
    }),
    [persist],
  );

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
      // EMAs de la estrategia (entrada/segunda/pullback/bias); la librería trae
      // 6/12/20 por defecto, así que forzamos calcParams vía el fork.
      mainIndicators: [{ name: 'EMA', calcParams: [10, 20, 55, 200] }],
      timezone: resolveTimezone(timezone),
      // El buscador interno cambió el símbolo → que el panel de orden lo siga.
      onSymbolChange: (ticker) => onSymbolChangeRef.current?.(ticker),
      // La PeriodBar interna cambió el timeframe → reflejarlo en el terminal.
      onPeriodChange: (period: Period) => onPeriodChangeRef.current?.(period.text),
      // Overlays creados/movidos/borrados desde la DrawingBar nativa → persistir.
      onOverlayEvent: (evType, overlay) => persist(evType, overlay),
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
    if (!chartRef.current) return;
    chartRef.current.setTimezone(resolveTimezone(timezone));
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

  // Persistencia de dibujos: al cambiar de símbolo, limpiar el grupo
  // 'drawing_tools' del símbolo anterior y rehidratar los guardados del nuevo.
  // NUNCA se toca el grupo 'positions' (líneas de entry/TP/SL).
  useEffect(() => {
    const chart = chartRef.current?.getChart?.();
    if (!chart || !symbol) return;
    rehydratingRef.current = true;
    try {
      chart.removeOverlay({ groupId: DRAWINGS_GROUP });
      const saved = getDrawingsRef.current(symbol);
      for (const d of saved) {
        chart.createOverlay(overlayFromSaved(d));
      }
    } finally {
      rehydratingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, canCreate]);

  // Dibuja entry / TP / SL de las posiciones del símbolo actual sobre el chart
  // interno de klinecharts (expuesto por nuestro fork vía getChart()). Read-only
  // por ahora (lock: true); respeta los ajustes showPositions / showTpSl.
  useEffect(() => {
    const pro = chartRef.current;
    const chart = pro?.getChart?.();
    if (!chart) return;
    chart.removeOverlay({ groupId: POSITIONS_GROUP });
    const symbolPositions = (positions ?? []).filter((p) => p.symbol === symbol);
    for (const pos of symbolPositions) {
      const line = (value: number, color: string) =>
        chart.createOverlay({
          name: 'horizontalStraightLine',
          groupId: POSITIONS_GROUP,
          lock: true,
          points: [{ value }],
          styles: { line: { color, style: LineType.Dashed } },
        });
      if (showPositions && Number.isFinite(pos.avgPrice)) line(pos.avgPrice, 'rgba(226,228,233,0.7)');
      if (showTpSl && pos.tp && pos.tp > 0) line(pos.tp, '#2ed68d');
      if (showTpSl && pos.sl && pos.sl > 0) line(pos.sl, '#ef5350');
    }
  }, [positions, symbol, currentSymbolInfo?.ticker, canCreate, showPositions, showTpSl]);

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <div ref={containerRef} className="absolute inset-0" />
    </div>
  );
}
