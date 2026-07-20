import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsRight } from 'lucide-react';
import { TooltipShowRule } from 'klinecharts';
import type { Overlay, OverlayCreate } from 'klinecharts';
import { KLineChartPro } from '@klinecharts/pro';
import type { SymbolInfo, Period } from '@klinecharts/pro';
// CSS del FORK vendored (no del paquete de node_modules): incluye los estilos
// responsive móviles de los modales. El alias de Vite solo re-mapea el JS.
import '../../vendor/klinecharts-pro/dist/klinecharts-pro.css';

import { cn } from '@/lib/utils';
import { useAccountSymbols } from '@/hooks/useAccountSymbols';
import { useMarketSocket } from '@/contexts/MarketSocketContext';
import { formatSymbolDisplay } from '@/lib/symbolDisplay';
import { KaiDatafeed } from '@/lib/chartPro/KaiDatafeed';
import { CHART_PRO_PERIODS, periodForTimeframe, timeframeFromKeyInput } from '@/lib/chartPro/periods';
import { useChartDrawings, type SavedDrawing } from '@/hooks/useChartDrawings';
import { buildKaiTradeBoxes, KAI_TRADES_GROUP } from '@/lib/chartPro/kaiTradeBoxes';
import { registerKaiPositionBoxOverlay } from '@/lib/chartPro/kaiPositionBox';
import {
  registerOrderPreviewBoxOverlay,
  ORDER_ENTRY_LINE_NAME,
  ORDER_LEVEL_LINE_NAME,
  setOrderLevelChangeHandler,
} from '@/lib/chartPro/orderPreviewBox';
import type { TradingHistoryItem } from '@/types/trading';
import { FloatingToolbar } from '@/components/FloatingToolbar';
import { MobileDrawTools } from '@/components/MobileDrawTools';
import { TimeframeInputModal } from '@/components/TimeframeInputModal';

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

// Registro global (idempotente) del overlay read-only de trades de Kai.
registerKaiPositionBoxOverlay();
// Overlay editable de preview de orden (TP/SL arrastrables).
registerOrderPreviewBoxOverlay();

interface KaiChartProProps {
  symbol?: string | null;
  accountId?: string | null;
  positions?: CopyTradingPosition[];
  // Trades CERRADOS de la cuenta (historial). Se dibujan como marcadores
  // LONG/SHORT sobre el chart para el símbolo mostrado.
  historyTrades?: TradingHistoryItem[];
  timeframe?: string;
  timezone?: string;
  className?: string;
  // Mostrar/ocultar líneas de entrada y TP/SL (ajustes del terminal).
  showPositions?: boolean;
  showTpSl?: boolean;
  // Spec del símbolo activo (futuros) para calcular el USD en SL/TP de las cajas.
  tickSize?: number | null;
  tickValue?: number | null;
  // El buscador interno de Pro cambió el símbolo → que el terminal lo siga.
  onSymbolChange?: (ticker: string) => void;
  // La PeriodBar interna cambió el timeframe → reflejarlo en el terminal.
  onPeriodChange?: (timeframe: string) => void;
  // Petición de "llevar el chart a este trade" (doble clic en ÓRDENES). from/to
  // = entrada/salida del trade (para encuadrar la caja). El nonce hace que dos
  // clics al mismo trade re-disparen el scroll.
  focusTrade?: { symbol: string; from: number; to: number; nonce: number } | null;
  // Preview EDITABLE de una orden que aún no se ha enviado: zona verde (entry→tp)
  // y roja (entry→sl) con handles arrastrables. Al arrastrar se llama a
  // onOrderTpChange/onOrderSlChange para sincronizar el formulario del terminal.
  // null / undefined = sin preview (ni TP ni SL activos).
  orderPreview?: { side: 'buy' | 'sell'; entry: number; tp: number; sl: number } | null;
  onOrderTpChange?: (price: number) => void;
  onOrderSlChange?: (price: number) => void;
  // SL/TP ARRASTRABLES de posiciones ABIERTAS: cada línea lleva el ticket; al
  // soltar se llama onPositionStopChange para modificar el stop en el bróker.
  positionStops?: Array<{
    ticket: string;
    side: 'LONG' | 'SHORT';
    entry: number;
    sl: number; // 0 = sin SL
    tp: number; // 0 = sin TP
  }>;
  onPositionStopChange?: (ticket: string, kind: 'tp' | 'sl', price: number) => void;
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
  historyTrades,
  timeframe = '1h',
  timezone,
  className,
  showPositions = true,
  showTpSl = true,
  tickSize = null,
  tickValue = null,
  onSymbolChange,
  onPeriodChange,
  focusTrade,
  orderPreview,
  onOrderTpChange,
  onOrderSlChange,
  positionStops,
  onPositionStopChange,
}: KaiChartProProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<KLineChartPro | null>(null);
  const datafeedRef = useRef<KaiDatafeed | null>(null);

  // Overlay de carga: tapa el estado vacío ("bolsa") de klinecharts-pro
  // mientras el datafeed trae el histórico (getHistoryKLineData). Arranca en
  // true (mount) y al cambiar de símbolo; el datafeed lo apaga vía
  // onHistoryLoaded cuando la respuesta llega (haya velas o no).
  const [loadingHistory, setLoadingHistory] = useState(true);

  const { symbols: accountSymbols } = useAccountSymbols(accountId ?? undefined);
  const { ticks, subscribe, unsubscribe, isConnected } = useMarketSocket();
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

  // Preview de orden editable: ids de los 3 overlays de 1 punto (entry/tp/sl),
  // flag de "arrastrando ahora" (evita que el effect los recree bajo el dedo) y
  // callbacks frescos.
  const orderEntryIdRef = useRef<string | null>(null);
  const orderTpIdRef = useRef<string | null>(null);
  const orderSlIdRef = useRef<string | null>(null);
  const orderDraggingRef = useRef(false);
  const onOrderTpRef = useRef(onOrderTpChange);
  onOrderTpRef.current = onOrderTpChange;
  const onOrderSlRef = useRef(onOrderSlChange);
  onOrderSlRef.current = onOrderSlChange;

  // SL/TP arrastrables de posiciones abiertas: ids de overlay por `${ticket}:${kind}`,
  // callback fresco y set de tickets con drag en curso (para no recrear bajo el dedo).
  const positionStopIdsRef = useRef<Map<string, string>>(new Map());
  const positionDraggingRef = useRef<Set<string>>(new Set());
  const onPositionStopRef = useRef(onPositionStopChange);
  onPositionStopRef.current = onPositionStopChange;
  // Nonce para reconciliar la línea a la verdad del bróker al soltar (si el modify
  // se rechaza, positionStops no cambia y la línea debe volver a su sitio real).
  const [posReconcile, setPosReconcile] = useState(0);

  // Handler global (registrado una vez) que recibe los cambios de nivel al
  // arrastrar. Con ticket = SL/TP de una POSICIÓN ABIERTA → modificar en bróker;
  // sin ticket = preview de orden nueva → sincronizar el formulario.
  useEffect(() => {
    setOrderLevelChangeHandler((kind, value, phase, ticket) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chart = chartRef.current?.getChart?.() as any;
      if (ticket) {
        const key = `${ticket}:${kind}`;
        if (phase === 'end') {
          positionDraggingRef.current.delete(key);
          onPositionStopRef.current?.(ticket, kind, value);
          const id = positionStopIdsRef.current.get(key);
          if (chart && id) chart.overrideOverlay({ id });
          // Reconciliar: re-corre el effect para dejar la línea en el SL/TP REAL
          // (revierte si el bróker rechazó; se re-alinea cuando llega el refetch).
          setPosReconcile((n) => n + 1);
        } else {
          positionDraggingRef.current.add(key);
        }
        return;
      }
      orderDraggingRef.current = phase !== 'end';
      if (kind === 'tp') onOrderTpRef.current?.(value);
      else onOrderSlRef.current?.(value);
      if (phase === 'end') {
        const id = kind === 'tp' ? orderTpIdRef.current : orderSlIdRef.current;
        if (chart && id) chart.overrideOverlay({ id });
      }
    });
    return () => setOrderLevelChangeHandler(null);
  }, []);

  // Guardia: durante la rehidratación limpiamos+recreamos overlays y NO queremos
  // que esos removes/creates programáticos se persistan (borrarían el símbolo
  // recién seleccionado).
  const rehydratingRef = useRef(false);

  // Persistencia central: toda alta/movimiento/borrado de un overlay de dibujo
  // pasa por aquí (tanto los creados desde la DrawingBar nativa vía onOverlayEvent
  // del fork, como los rehidratados que llevan sus propios callbacks).
  // Pila de dibujos en orden de creación → Ctrl+Z deshace el último.
  const drawnIdsRef = useRef<string[]>([]);

  // Ids de las cajas de trades de Kai dibujadas actualmente (grupo kai_trades),
  // para reconciliar sin borrar las ediciones del usuario.
  const kaiBoxIdsRef = useRef<string[]>([]);

  // Buffer visible del modal "Cambiar Intervalo" (lo que el usuario teclea).
  const [tfInput, setTfInput] = useState<string | null>(null);

  const persist = useCallback((type: 'created' | 'updated' | 'removed', overlay: Overlay) => {
    if (rehydratingRef.current) return;
    if (overlay.groupId !== DRAWINGS_GROUP) return;
    const sym = symbolRef.current;
    if (!sym) return;
    if (type === 'removed') {
      drawnIdsRef.current = drawnIdsRef.current.filter((id) => id !== overlay.id);
      removeDrawingRef.current(sym, overlay.id);
    } else {
      if (type === 'created' && !drawnIdsRef.current.includes(overlay.id)) {
        drawnIdsRef.current.push(overlay.id);
      }
      saveDrawingRef.current(sym, overlay);
    }
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
      onHistoryLoaded: () => setLoadingHistory(false),
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
      // Sin panel de volumen por defecto (el Pro trae ['VOL']): se activa
      // desde Indicator → Sub Indicator → VOL, y el fork lo crea limpio
      // (sin medias móviles encima de las barras).
      subIndicators: [],
      timezone: resolveTimezone(timezone),
      // El buscador interno cambió el símbolo → que el panel de orden lo siga.
      onSymbolChange: (ticker) => onSymbolChangeRef.current?.(ticker),
      // La PeriodBar interna cambió el timeframe → reflejarlo en el terminal.
      onPeriodChange: (period: Period) => onPeriodChangeRef.current?.(period.text),
      // Overlays creados/movidos/borrados desde la DrawingBar nativa → persistir.
      onOverlayEvent: (evType, overlay) => persist(evType, overlay),
    });
    // Estilo del chart interno de klinecharts (velas/grid/ejes/crosshair) para
    // fundirlo con la paleta near-black. Verde=alza, rojo=baja (dirección). El
    // optional chaining evita lanzar si getChart() aún no está listo.
    chartRef.current.getChart()?.setStyles({
      // Grid OFF por default (se reactiva desde Setting).
      grid: { show: false, horizontal: { color: 'rgba(255,255,255,0.04)' }, vertical: { color: 'rgba(255,255,255,0.04)' } },
      candle: {
        bar: {
          upColor: '#2ed68d', downColor: '#ef5350', noChangeColor: '#888888',
          upBorderColor: '#2ed68d', downBorderColor: '#ef5350',
          upWickColor: 'rgba(46,214,141,0.75)', downWickColor: 'rgba(239,83,80,0.75)',
        },
        priceMark: {
          // Marcas de máximo/mínimo OFF por default (se reactivan desde Setting).
          high: { show: false, color: 'rgba(226,228,233,0.7)' }, low: { show: false, color: 'rgba(226,228,233,0.7)' },
          last: {
            upColor: '#2ed68d', downColor: '#ef5350', noChangeColor: '#888888',
            text: { color: '#ffffff' },
          },
        },
        // Leyenda OHLC (Time/Open/High/Low/Close/Volume) OCULTA por default;
        // se reactiva desde Setting ("Datos OHLC"). showRule 'none' = no mostrar.
        tooltip: { showRule: TooltipShowRule.None, text: { color: 'rgba(226,228,233,0.85)' } },
      },
      xAxis: { axisLine: { color: 'rgba(255,255,255,0.06)' }, tickText: { color: 'rgba(226,228,233,0.55)' }, tickLine: { color: 'rgba(255,255,255,0.06)' } },
      yAxis: { axisLine: { color: 'rgba(255,255,255,0.06)' }, tickText: { color: 'rgba(226,228,233,0.55)' }, tickLine: { color: 'rgba(255,255,255,0.06)' } },
      crosshair: {
        horizontal: { line: { color: 'rgba(148,163,184,0.4)' }, text: { backgroundColor: '#0d0f16' } },
        vertical: { line: { color: 'rgba(148,163,184,0.4)' }, text: { backgroundColor: '#0d0f16' } },
      },
      // Leyenda de indicadores (EMA10/20/55/200) también oculta por default.
      indicator: { tooltip: { showRule: TooltipShowRule.None, text: { color: 'rgba(226,228,233,0.7)' } } },
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
    // Volvemos a mostrar el overlay: setSymbol dispara un getHistoryKLineData
    // nuevo y no queremos que asome la "bolsa" durante el re-fetch.
    setLoadingHistory(true);
    chartRef.current.setSymbol(currentSymbolInfo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSymbolInfo?.ticker, accountId]);

  // Doble clic en un trade de ÓRDENES → llevar el chart a ese momento. Si el
  // símbolo cambió, setSymbol recarga el histórico de forma ASÍNCRONA y
  // applyNewData resetea la vista al final; por eso esperamos a que la data se
  // ESTABILICE (misma longitud + último timestamp en dos sondeos seguidos)
  // antes de hacer scroll. Timeout ~3.6s → best-effort al borde (trade fuera de
  // rango cargado). El nonce permite re-disparar el mismo trade.
  useEffect(() => {
    if (!focusTrade || !Number.isFinite(focusTrade.from)) return;
    const exit = Number.isFinite(focusTrade.to) ? focusTrade.to : focusTrade.from;
    const mid = (focusTrade.from + exit) / 2;
    let cancelled = false;
    let attempts = 0;
    let prevSig = '';
    const tick = () => {
      if (cancelled) return;
      const chart = chartRef.current?.getChart?.() as any;
      const data: Array<{ timestamp: number }> = chart?.getDataList?.() ?? [];
      const vr = chart?.getVisibleRange?.();
      const vbars = vr ? Math.round(vr.to - vr.from) : 0;
      // La firma incluye datos (recarga) Y el nº de barras visibles (zoom/
      // layout): NO medimos el span hasta que el zoom se ha ASENTADO — si no,
      // sale inflado y el scroll deja el trade fuera de pantalla.
      const sig = data.length
        ? `${data.length}:${data[data.length - 1].timestamp}:${vbars}`
        : '';
      const stable = sig !== '' && sig === prevSig;
      prevSig = sig;
      if (chart && data.length > 0 && vr && vbars > 0 && (stable || attempts >= 24)) {
        // Centrado PRECISO por ÍNDICE de barra (no por tiempo, que se deforma
        // con los gaps de finde/noche): scrollToDataIndex ancla el índice en el
        // BORDE DERECHO, así que right-edge = midIdx + mitad de barras visibles
        // → la barra del trade queda en el centro exacto.
        let lo = 0;
        let hi = data.length - 1;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          if (data[m].timestamp < mid) lo = m + 1;
          else hi = m;
        }
        const midIdx = lo;
        // right-edge = midIdx + mitad de barras visibles − 2 (padding derecho
        // por defecto de klinecharts) → la barra del trade queda en el centro.
        // Clamp a [midIdx, data.length−1]: en TF gruesos (5m/D/W) o trades cerca
        // del borde, rightIdx se salía de rango y scrollToDataIndex clampeaba al
        // final (parecía "no navega"). Así la barra del trade SIEMPRE queda visible.
        const rightIdx = Math.max(
          midIdx,
          Math.min(data.length - 1, midIdx + Math.floor(vbars / 2) - 2),
        );
        chart.scrollToDataIndex(rightIdx, 400);
        return;
      }
      attempts += 1;
      setTimeout(tick, 150);
    };
    tick();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTrade?.nonce]);

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

  // Recarga al RECONECTAR (isConnected false→true): si un corte de red dejó el
  // chart vacío/con 1 vela, re-fetcheamos el histórico y lo aplicamos. Solo si
  // el chart está "roto" (pocas velas) para no resetear la vista de un chart sano.
  const prevConnectedRef = useRef(isConnected);
  useEffect(() => {
    const was = prevConnectedRef.current;
    prevConnectedRef.current = isConnected;
    if (was || !isConnected) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chart = chartRef.current?.getChart?.() as any;
    const df = datafeedRef.current;
    if (!chart || !df || !currentSymbolInfo) return;
    const count = chart.getDataList?.()?.length ?? 0;
    if (count >= 5) return; // el chart ya tiene historia; no lo tocamos
    df.getHistoryKLineData(currentSymbolInfo, periodForTimeframe(timeframe))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .then((d: any[]) => { if (d.length > 0) chart.applyNewData(d, true); })
      .catch(() => { /* noop */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  // Resize del chart cuando su CONTENEDOR cambia de tamaño (no solo la ventana).
  // El fork solo escucha `window.resize`; al abrir/cerrar el panel inferior
  // (CUENTAS/POSICIONES/…) el contenedor se encoge pero el canvas mantenía su
  // alto viejo y, con overflow-hidden, el eje X (abajo) quedaba recortado.
  // Un ResizeObserver → getChart().resize() mantiene el eje visible.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => chartRef.current?.getChart()?.resize());
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Atajos de teclado estilo TradingView.
  useEffect(() => {
    let tfBuffer = '';
    let tfTimer = 0;
    const commitTf = (input: string) => {
      const tf = timeframeFromKeyInput(input);
      tfBuffer = '';
      setTfInput(null);
      if (tf) onPeriodChangeRef.current?.(tf);
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chart = chartRef.current?.getChart?.() as any;
      if (!chart) return;
      const mod = e.ctrlKey || e.metaKey;

      // Ctrl/Cmd+Z → deshacer el último dibujo (uno por uno).
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'z') {
        const last = drawnIdsRef.current[drawnIdsRef.current.length - 1];
        if (last) chart.removeOverlay({ id: last });
        e.preventDefault();
        return;
      }

      // Alt + letra → activar herramienta de dibujo.
      if (e.altKey) {
        const tool: Record<string, string> = {
          t: 'segment', h: 'horizontalStraightLine', v: 'verticalStraightLine',
          r: 'rayLine', f: 'fibonacciLine',
        };
        const name = tool[e.key.toLowerCase()];
        if (name) {
          chart.createOverlay({
            name,
            groupId: DRAWINGS_GROUP,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onDrawEnd: (ev: any) => { persist('created', ev.overlay); return false; },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onPressedMoveEnd: (ev: any) => { persist('updated', ev.overlay); return false; },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            onRemoved: (ev: any) => { persist('removed', ev.overlay); return false; },
          });
          e.preventDefault();
          return;
        }
      }

      // Escribir número o D/W/M → cambiar temporalidad (como TradingView).
      if (!mod && !e.altKey) {
        if (/^[0-9]$/.test(e.key)) {
          tfBuffer += e.key;
          setTfInput(tfBuffer);
          window.clearTimeout(tfTimer);
          tfTimer = window.setTimeout(() => commitTf(tfBuffer), 900);
          e.preventDefault();
        } else if (/^[dwm]$/i.test(e.key)) {
          commitTf(e.key);
          e.preventDefault();
        } else if (e.key === 'Enter' && tfBuffer) {
          window.clearTimeout(tfTimer);
          commitTf(tfBuffer);
          e.preventDefault();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(tfTimer);
      window.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // CADA trade de Kai (posiciones abiertas + trades cerrados del símbolo actual)
  // se dibuja como caja LONG/SHORT — herramienta `positionLong`/`positionShort`
  // del fork — con Entry/SL/TP REALES. Grupo propio (no se persiste como dibujo
  // del usuario). Editables: en vez de borrar-y-redibujar todo el grupo en cada
  // refresco (lo que borraría el arrastre del usuario), RECONCILIAMOS por id
  // estable — agregamos las nuevas, quitamos las que desaparecieron y dejamos
  // intactas las existentes.
  useEffect(() => {
    const chart = chartRef.current?.getChart?.();
    if (!chart) return;
    const desired = buildKaiTradeBoxes({
      positions,
      history: historyTrades,
      symbol,
      showPositions,
      showTpSl,
      now: Date.now(),
      tickSize,
      tickValue,
    });
    const desiredIds = new Set(desired.map((d) => d.id));
    for (const prevId of kaiBoxIdsRef.current) {
      if (!desiredIds.has(prevId)) chart.removeOverlay({ id: prevId });
    }
    const prev = new Set(kaiBoxIdsRef.current);
    for (const d of desired) {
      // Nuevas → crear; existentes → override (refresca P&L/USD y el borde derecho
      // de la caja abierta en vivo, sin borrar-y-recrear). Son lock:true read-only.
      if (!prev.has(d.id)) chart.createOverlay({ ...d.overlay, id: d.id });
      else chart.overrideOverlay({ ...d.overlay, id: d.id });
    }
    kaiBoxIdsRef.current = Array.from(desiredIds);
  }, [positions, historyTrades, symbol, currentSymbolInfo?.ticker, canCreate, showPositions, showTpSl, tickSize, tickValue]);

  // Preview de orden EDITABLE (estilo Exness): 3 overlays de 1 punto — línea de
  // entrada estática + líneas de TP/SL ARRASTRABLES. Al arrastrar una línea de
  // nivel, el template llama al handler global (registrado arriba) que sincroniza
  // el formulario y pinta la sombra. Este effect solo crea/actualiza/quita los
  // overlays según el form; NO toca nada mientras el usuario arrastra.
  const opActive = !!orderPreview;
  const opEntry = orderPreview?.entry ?? 0;
  const opTp = orderPreview?.tp ?? 0;
  const opSl = orderPreview?.sl ?? 0;
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chart = chartRef.current?.getChart?.() as any;
    if (!chart) return;
    const dropAll = () => {
      for (const ref of [orderEntryIdRef, orderTpIdRef, orderSlIdRef]) {
        if (ref.current) { chart.removeOverlay({ id: ref.current }); ref.current = null; }
      }
    };
    // Sin preview activo → quitar todo.
    if (!opActive || !(opEntry > 0)) { dropAll(); return; }
    // El usuario está arrastrando ahora: no recrear/override bajo su dedo.
    if (orderDraggingRef.current) return;

    // Un timestamp cualquiera para posicionar el punto (la línea es de ancho
    // completo, así que el x da igual; solo el precio/Y importa).
    const data: Array<{ timestamp: number }> = chart.getDataList?.() ?? [];
    if (!data.length) return;
    const anchor = data[Math.max(0, data.length - 8)]?.timestamp ?? data[data.length - 1].timestamp;

    // Sincroniza un overlay de 1 punto: crea si falta, override si existe, quita si
    // el nivel se apagó.
    const sync = (
      ref: React.MutableRefObject<string | null>,
      on: boolean,
      value: number,
      name: string,
      extendData: Record<string, unknown> | undefined,
      lock: boolean,
    ) => {
      if (!on) {
        if (ref.current) { chart.removeOverlay({ id: ref.current }); ref.current = null; }
        return;
      }
      const points = [{ timestamp: anchor, value }];
      if (!ref.current) {
        const id = chart.createOverlay({ name, points, lock, extendData });
        ref.current = typeof id === 'string' ? id : Array.isArray(id) ? id[0] : null;
      } else {
        chart.overrideOverlay({ id: ref.current, points, extendData });
      }
    };

    sync(orderEntryIdRef, true, opEntry, ORDER_ENTRY_LINE_NAME, undefined, true);
    sync(orderTpIdRef, opTp > 0, opTp, ORDER_LEVEL_LINE_NAME, { kind: 'tp', entryValue: opEntry }, false);
    sync(orderSlIdRef, opSl > 0, opSl, ORDER_LEVEL_LINE_NAME, { kind: 'sl', entryValue: opEntry }, false);
  }, [opActive, opEntry, opTp, opSl]);

  // SL/TP ARRASTRABLES de posiciones abiertas: una línea `orderLevelLine` por
  // nivel (con el ticket en extendData). Al soltar, el handler global modifica el
  // stop en el bróker. No recrea la línea que el usuario está arrastrando ahora.
  const posStopsKey = JSON.stringify(positionStops ?? []);
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chart = chartRef.current?.getChart?.() as any;
    if (!chart) return;
    const ids = positionStopIdsRef.current;
    const stops = positionStops ?? [];
    const data: Array<{ timestamp: number }> = chart.getDataList?.() ?? [];
    if (!data.length && stops.length) return;
    const anchor = data.length
      ? data[Math.max(0, data.length - 8)]?.timestamp ?? data[data.length - 1].timestamp
      : 0;

    const desired = new Map<string, { value: number; entry: number; kind: 'tp' | 'sl'; ticket: string }>();
    for (const p of stops) {
      if (p.tp > 0) desired.set(`${p.ticket}:tp`, { value: p.tp, entry: p.entry, kind: 'tp', ticket: p.ticket });
      if (p.sl > 0) desired.set(`${p.ticket}:sl`, { value: p.sl, entry: p.entry, kind: 'sl', ticket: p.ticket });
    }

    // Quitar overlays que ya no se desean (y no se están arrastrando).
    for (const [key, id] of Array.from(ids.entries())) {
      if (!desired.has(key) && !positionDraggingRef.current.has(key)) {
        chart.removeOverlay({ id });
        ids.delete(key);
      }
    }
    // Crear/actualizar los deseados (salvo el que está bajo el dedo).
    for (const [key, d] of desired) {
      if (positionDraggingRef.current.has(key)) continue;
      const points = [{ timestamp: anchor, value: d.value }];
      const extendData = { kind: d.kind, entryValue: d.entry, ticket: d.ticket };
      const existing = ids.get(key);
      if (!existing) {
        const id = chart.createOverlay({ name: ORDER_LEVEL_LINE_NAME, points, lock: false, extendData });
        const resolved = typeof id === 'string' ? id : Array.isArray(id) ? id[0] : null;
        if (resolved) ids.set(key, resolved);
      } else {
        chart.overrideOverlay({ id: existing, points, extendData });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posStopsKey, posReconcile]);

  // Activa una herramienta de dibujo en el chart (usado por la barra flotante de
  // favoritos y análogo a los atajos Alt+tecla).
  const activateTool = useCallback((name: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chart = chartRef.current?.getChart?.() as any;
    if (!chart) return;
    chart.createOverlay({
      name,
      groupId: DRAWINGS_GROUP,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onDrawEnd: (ev: any) => { persist('created', ev.overlay); return false; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onPressedMoveEnd: (ev: any) => { persist('updated', ev.overlay); return false; },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onRemoved: (ev: any) => { persist('removed', ev.overlay); return false; },
    });
  }, [persist]);

  // Borra todos los dibujos del grupo (usado por el bottom sheet móvil).
  const clearDrawings = useCallback(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chart = chartRef.current?.getChart?.() as any;
    chart?.removeOverlay({ groupId: DRAWINGS_GROUP });
  }, []);

  // "Volver a hoy": vuelve al presente tras explorar días atrás (klinecharts
  // scrollToRealTime). Botón flotante estilo TradingView.
  const goToRealtime = useCallback(() => {
    chartRef.current?.getChart?.()?.scrollToRealTime?.(360);
  }, []);

  // El botón "Hoy" solo aparece con el mouse CERCA de su esquina (menos ruido
  // visual). Se rastrea proximidad en el wrapper — un hot-zone superpuesto
  // bloquearía el pan/crosshair de klinecharts.
  const [nearHoy, setNearHoy] = useState(false);
  const handleHoyProximity = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setNearHoy(rect.right - e.clientX < 190 && rect.bottom - e.clientY < 100);
  }, []);

  return (
    <div
      className={cn('relative min-h-0 flex-1', className)}
      onMouseMove={handleHoyProximity}
      onMouseLeave={() => setNearHoy(false)}
    >
      <div ref={containerRef} className="absolute inset-0" />
      {canCreate && loadingHistory && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background">
          <p className="text-[11px] text-muted-foreground">Cargando velas</p>
        </div>
      )}
      <FloatingToolbar onSelectTool={activateTool} />
      <MobileDrawTools onSelectTool={activateTool} onClearDrawings={clearDrawings} />
      <TimeframeInputModal input={tfInput} />
      <button
        type="button"
        onClick={goToRealtime}
        title="Volver al presente"
        aria-label="Volver al presente"
        className={cn(
          'absolute bottom-8 right-[68px] z-10 flex items-center gap-1 rounded-md border border-border/60 bg-background/85 px-2 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur transition-opacity duration-150 hover:text-foreground',
          nearHoy ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      >
        <ChevronsRight className="h-3.5 w-3.5" />
        Hoy
      </button>
    </div>
  );
}
