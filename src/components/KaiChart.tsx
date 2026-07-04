import { useEffect, useRef, useState, useCallback, useMemo, type ReactNode } from 'react';
import { init, dispose, registerOverlay, LineType, ActionType, OverlayMode, LoadDataType } from 'klinecharts';
import type { Chart, KLineData, OverlayEvent } from 'klinecharts';
import {
  Camera, Search, AlertCircle, BarChart2, TrendingUp, TrendingDown, Eraser,
  MousePointer2, MoveUpRight, Minus, MoveVertical, Equal, Square, Circle, Triangle, AlignJustify, Type, Trash2, Magnet,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { REAL_CONFIRMATION_TEXT } from '@/constants/tradingExecution';
import { useUpdateTradingPositionStops } from '@/hooks/useUpdateTradingPositionStops';
import { useMarketCandles, fetchCandles, type MarketCandle } from '@/modules/copyTrading/hooks/useMarketCandles';
import { useMarketSocket } from '@/contexts/MarketSocketContext';
import { formatSymbolDisplay, symbolIcon } from '@/lib/symbolDisplay';
import type { CopyTradingPosition } from '@/modules/copyTrading/types';

const TIMEFRAMES = ['1m', '5m', '10m', '15m', '30m', '1h', '2h', '4h', 'D', 'W', 'M'] as const;
type Timeframe = typeof TIMEFRAMES[number];
type StopEditKind = 'tp' | 'sl';

const CANDLE_PANE_ID = 'candle_pane';
// Initial candle window requested from MT5. Lazy-load extends this when the
// user scrolls back in time (see setLoadDataCallback in KaiChart).
const INITIAL_CANDLE_COUNT = 20000;

// Module-level empty fallbacks so "no data yet" keeps a stable identity across
// renders (see the comment where `candles` is derived below).
const EMPTY_CANDLES: MarketCandle[] = [];
const EMPTY_POSITIONS: CopyTradingPosition[] = [];

interface DrawingTool {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** klinecharts overlay template name; undefined => action handled inline */
  overlay?: string;
  danger?: boolean;
  separator?: boolean;
}

// Each tool maps to a real klinecharts overlay template, so the buttons
// actually draw on the chart instead of being inert.
const DRAWING_TOOLS: DrawingTool[] = [
  { id: 'cursor', label: 'Cursor', icon: MousePointer2 },
  { id: 'magnet', label: 'Imán (ajustar a velas)', icon: Magnet },
  { id: 'sep1', label: '', separator: true },
  { id: 'trendline', label: 'Línea de tendencia', icon: TrendingUp, overlay: 'segment' },
  { id: 'ray', label: 'Línea de rayo', icon: MoveUpRight, overlay: 'rayLine' },
  { id: 'hline', label: 'Línea horizontal', icon: Minus, overlay: 'horizontalStraightLine' },
  { id: 'vline', label: 'Línea vertical', icon: MoveVertical, overlay: 'verticalStraightLine' },
  { id: 'channel', label: 'Canal paralelo', icon: Equal, overlay: 'parallelStraightLine' },
  { id: 'sep2', label: '', separator: true },
  { id: 'rect', label: 'Rectángulo', icon: Square, overlay: 'rect' },
  { id: 'circle', label: 'Círculo', icon: Circle, overlay: 'circle' },
  { id: 'triangle', label: 'Triángulo', icon: Triangle, overlay: 'triangle' },
  { id: 'sep3', label: '', separator: true },
  { id: 'fib', label: 'Fibonacci', icon: AlignJustify, overlay: 'fibonacciLine' },
  { id: 'text', label: 'Texto / nota', icon: Type, overlay: 'simpleAnnotation' },
  { id: 'sep4', label: '', separator: true },
  { id: 'clear', label: 'Borrar dibujos', icon: Trash2, danger: true },
];

// Only indicators that klinecharts implements natively — no dead buttons.
const INDICATOR_CATEGORIES = {
  Tendencia: ['MA', 'EMA', 'BOLL', 'SAR', 'BBI'],
  Osciladores: ['MACD', 'RSI', 'KDJ', 'CCI', 'WR'],
  Volumen: ['VOL', 'OBV', 'PVT'],
} as const;

// Indicators that overlay the candle pane instead of opening their own sub-pane.
const MAIN_PANE_INDICATORS = new Set(['MA', 'EMA', 'BOLL', 'SAR', 'BBI']);

// Períodos por defecto alineados con la estrategia. Los EMAs de los videos que
// usamos son 10/20/55/200 (entrada/segunda/pullback/bias); klinecharts trae EMA
// con [6,12,20] por defecto, así que lo sobreescribimos al crear el indicador.
const INDICATOR_DEFAULT_PARAMS: Record<string, number[]> = {
  EMA: [10, 20, 55, 200],
};

// klinecharts 9.8.12 NO trae un overlay `triangle` nativo, así que el botón de
// triángulo hacía click sin dibujar nada (createOverlay('triangle') es no-op
// silencioso para nombres desconocidos). Registramos uno propio de 3 puntos.
let triangleOverlayRegistered = false;
function ensureTriangleOverlay() {
  if (triangleOverlayRegistered) return;
  triangleOverlayRegistered = true;
  registerOverlay({
    name: 'triangle',
    totalStep: 4, // 3 puntos + el paso inicial
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates }) => {
      if (coordinates.length < 2) return [];
      return [
        {
          type: 'polygon',
          attrs: { coordinates: coordinates.slice(0, 3) },
          styles: {
            style: 'stroke',
            borderColor: '#2962ff',
            borderSize: 1,
            borderStyle: 'solid',
          },
        },
      ];
    },
  });
}
ensureTriangleOverlay();

interface KaiChartProps {
  symbol?: string | null;
  accountId?: string | null;
  positions?: CopyTradingPosition[];
  timeframe?: string;
  onSymbolChange?: (symbol: string) => void;
  onAccountChange?: (accountId: string) => void;
  onTimeframeChange?: (timeframe: string) => void;
  showPositions?: boolean;
  showTpSl?: boolean;
  timezone?: string;
  className?: string;
}

const CHART_STYLES = {
  grid: {
    horizontal: { color: 'rgba(255,255,255,0.04)' },
    vertical: { color: 'rgba(255,255,255,0.04)' },
  },
  candle: {
    bar: {
      upColor: '#2ed68d',
      downColor: '#ef5350',
      noChangeColor: '#888888',
      upBorderColor: '#2ed68d',
      downBorderColor: '#ef5350',
      upWickColor: 'rgba(0,192,118,0.72)',
      downWickColor: 'rgba(255,59,48,0.72)',
    },
    tooltip: { text: { color: 'rgba(226,228,233,0.85)' } },
  },
  indicator: {
    tooltip: { text: { color: 'rgba(226,228,233,0.7)' } },
  },
  xAxis: { axisLine: { color: 'rgba(255,255,255,0.06)' }, tickText: { color: 'rgba(226,228,233,0.55)' } },
  yAxis: { axisLine: { color: 'rgba(255,255,255,0.06)' }, tickText: { color: 'rgba(226,228,233,0.55)' } },
  crosshair: {
    horizontal: { line: { color: 'rgba(148,163,184,0.4)' }, text: { backgroundColor: '#0d0f16' } },
    vertical: { line: { color: 'rgba(148,163,184,0.4)' }, text: { backgroundColor: '#0d0f16' } },
  },
};

function formatPrice(value: number | null | undefined, decimals = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatCandleTime(timeMs: number | null | undefined): string {
  if (!timeMs || !Number.isFinite(timeMs)) return '—';
  return new Intl.DateTimeFormat('es', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  }).format(new Date(timeMs));
}

function normalizeTimeframe(value: string | undefined): Timeframe {
  return TIMEFRAMES.includes(value as Timeframe) ? (value as Timeframe) : '1h';
}

// TradingView-style: type a number/unit then Enter to switch timeframe.
// Accepts e.g. "5"->5m, "60"->1h, "240"->4h, "1h", "4h", "d", "w", "m"(month).
function parseTfInput(raw: string): Timeframe | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const map: Record<string, Timeframe> = {
    '1': '1m', '1m': '1m',
    '5': '5m', '5m': '5m',
    '10': '10m', '10m': '10m',
    '15': '15m', '15m': '15m',
    '30': '30m', '30m': '30m',
    '60': '1h', '1h': '1h', 'h': '1h',
    '120': '2h', '2h': '2h',
    '240': '4h', '4h': '4h',
    'd': 'D', '1d': 'D',
    'w': 'W', '1w': 'W',
    'mn': 'M', 'mo': 'M', '1mn': 'M',
  };
  return map[s] ?? null;
}

export function KaiChart({
  symbol,
  accountId,
  positions,
  timeframe: timeframeProp,
  onTimeframeChange,
  showPositions = true,
  showTpSl = true,
  timezone = "local",
  className,
}: KaiChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  // name -> paneId for active indicators, so we can remove them precisely.
  const indicatorPanesRef = useRef<Map<string, string>>(new Map());
  // Tracks whether we've set the initial zoom for the current symbol/timeframe,
  // so periodic data refreshes don't reset the user's manual scroll/zoom.
  // Identifies the current dataset (symbol+timeframe). While it stays the same,
  // we update incrementally instead of replacing data (which would reset the
  // user's scroll/zoom back to the latest candle mid-analysis).
  const dataSigRef = useRef<string>('');
  const [timeframe, setTimeframeState] = useState<Timeframe>(() => normalizeTimeframe(timeframeProp));
  const [activeTool, setActiveTool] = useState<string>('cursor');
  const [showIndicators, setShowIndicators] = useState(false);
  const [indicatorSearch, setIndicatorSearch] = useState('');
  const [activeIndicators, setActiveIndicators] = useState<string[]>([]);
  const [editPos, setEditPos] = useState<CopyTradingPosition | null>(null);
  const [editTp, setEditTp] = useState("");
  const [editSl, setEditSl] = useState("");
  const [savingStops, setSavingStops] = useState(false);
  const [tfInput, setTfInput] = useState<string | null>(null);
  const [posLabels, setPosLabels] = useState<Array<{ id: string; y: number; color: string; label: string }>>([]);
  const [posZones, setPosZones] = useState<Array<{ id: string; top: number; height: number; bg: string }>>([]);
  const [magnet, setMagnet] = useState(false);
  const updateStops = useUpdateTradingPositionStops();
  const { ticks: liveTicks } = useMarketSocket();
  const liveTick = accountId && symbol ? liveTicks.get(`${accountId}::${symbol}`) ?? null : null;

  const { data: candlesData, isLoading: loadingCandles, error: candlesError } = useMarketCandles(
    accountId ?? null,
    symbol ?? null,
    timeframe,
    INITIAL_CANDLE_COUNT,
  );
  // Stable identity while the query has no data yet. A `= []` destructure
  // default creates a NEW array on every render, which re-fires every effect
  // keyed on [candles] on each render during loading — combined with the
  // tick-driven render storm this exceeded React's nested-update limit
  // ("Maximum update depth exceeded") and burned hundreds of renders in the
  // first ~500ms after mount.
  const candles = candlesData ?? EMPTY_CANDLES;

  const symbolPositions = useMemo(() => {
    if (!symbol || !positions) return EMPTY_POSITIONS;
    return positions.filter(p => p.symbol === symbol);
  }, [symbol, positions]);

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const hasPriceChange = Boolean(lastCandle && prevCandle && prevCandle.close !== 0);
  const priceChange = hasPriceChange && lastCandle && prevCandle ? lastCandle.close - prevCandle.close : null;
  const priceChangePct = priceChange !== null && prevCandle ? (priceChange / prevCandle.close) * 100 : null;
  const isPositive = priceChange == null || priceChange >= 0;
  const lastCandleTime = lastCandle?.time ?? null;
  // Forex / metals trade with sub-unit prices; widen the precision so the chart
  // doesn't round e.g. EURUSD 1.08732 down to 1.09.
  const pricePrecision = lastCandle && lastCandle.close > 0 && lastCandle.close < 20 ? 5 : 2;

  const setTimeframe = useCallback((tf: Timeframe) => {
    setTimeframeState(tf);
    onTimeframeChange?.(tf);
  }, [onTimeframeChange]);

  useEffect(() => {
    const nextTimeframe = normalizeTimeframe(timeframeProp);
    setTimeframeState((current) => (nextTimeframe !== current ? nextTimeframe : current));
  }, [timeframeProp]);

  // TradingView-style keyboard timeframe switch: type digits/units then Enter.
  useEffect(() => {
    let clearTimer: ReturnType<typeof setTimeout> | undefined;
    const armClear = () => {
      if (clearTimer) clearTimeout(clearTimer);
      clearTimer = setTimeout(() => setTfInput(null), 2000);
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
      if (e.key === 'Escape') { setTfInput(null); return; }
      if (e.key === 'Enter') {
        setTfInput((cur) => {
          if (cur) { const tf = parseTfInput(cur); if (tf) setTimeframe(tf); }
          return null;
        });
        return;
      }
      if (/^[0-9a-zA-Z]$/.test(e.key)) {
        setTfInput((cur) => ((cur ?? '') + e.key).slice(0, 4));
        armClear();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (clearTimer) clearTimeout(clearTimer);
    };
  }, [setTimeframe]);

  // ── Init / dispose ──────────────────────────────────────────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = init(el, { styles: CHART_STYLES });
    chartRef.current = chart;
    // A freshly-created chart (mount OR Vite HMR) is empty, so the next feed
    // run MUST do a full applyNewData + fit. Reset the signature here; otherwise
    // a ref that survived Fast Refresh makes the feed take the "update last
    // candle only" path and the chart renders just 1-2 huge candles.
    dataSigRef.current = '';

    // Keep the canvas in sync with its flex container (panel collapse, window
    // resize, mobile rotation). klinecharts needs an explicit resize() call.
    const resizeObserver = new ResizeObserver(() => chart?.resize());
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      dispose(el);
      chartRef.current = null;
    };
  }, []);

  // ── Timezone (Configuración) ────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const tz =
      timezone === "local"
        ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
        : timezone;
    try {
      chart.setTimezone(tz);
    } catch {
      /* invalid tz — ignore */
    }
  }, [timezone]);

  // ── Feed candle data ────────────────────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setPriceVolumePrecision(pricePrecision, 2);
    if (candles.length === 0) return;
    const data: KLineData[] = candles.map((c: MarketCandle) => ({
      timestamp: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
    }));

    const sig = `${symbol ?? ''}|${timeframe}`;
    const isNewDataset = sig !== dataSigRef.current;

    if (isNewDataset) {
      // Symbol/timeframe changed → replace the whole series and fit the view.
      dataSigRef.current = sig;
      chart.applyNewData(data);
      const width = containerRef.current?.clientWidth ?? 1000;
      const space = Math.max(2, Math.min(12, width / 240));
      chart.setBarSpace(space);
      chart.scrollToRealTime();
    } else {
      // Same dataset (periodic refresh) → update only the latest candle(s) so we
      // DON'T reset the user's scroll/zoom while they're analyzing the chart.
      chart.updateData(data[data.length - 1]);
      if (data.length >= 2) chart.updateData(data[data.length - 2]);
    }
  }, [candles, pricePrecision, symbol, timeframe]);

  // ── Lazy-load older history when the user scrolls left (infinite history,
  //    like TradingView). We re-request a larger window from MT5 and prepend the
  //    candles older than what's already on screen. No fixed limit. ───────────
  //
  // klinecharts 9.x semantics (counter-intuitive): `LoadDataType.Forward` fires
  // when the view reaches the OLDEST candle (left edge) and PREPENDS the data we
  // return; `Backward` fires at the NEWEST candle (right edge) and APPENDS.
  // Since the chart tracks real time, Backward fires on every visible-range
  // change — answering it with history used to append thousands of old candles
  // to the right of the series in an infinite fetch loop (constant flicker).
  // New candles arrive via updateData/ticks, so Backward must answer "no more".
  const loadMoreRef = useRef({ count: INITIAL_CANDLE_COUNT, busy: false });
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    loadMoreRef.current = { count: INITIAL_CANDLE_COUNT, busy: false };
    chart.setLoadDataCallback((params) => {
      if (params.type !== LoadDataType.Forward || !accountId || !symbol) {
        params.callback([], false);
        return;
      }
      const oldest = params.data?.timestamp;
      if (!oldest || loadMoreRef.current.busy) {
        params.callback([], !!oldest);
        return;
      }
      loadMoreRef.current.busy = true;
      const nextCount = loadMoreRef.current.count + INITIAL_CANDLE_COUNT;
      fetchCandles(accountId, symbol, timeframe, nextCount)
        .then((all) => {
          const older: KLineData[] = all
            .filter((c) => c.time < oldest)
            .map((c) => ({
              timestamp: c.time,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close,
              volume: c.volume ?? 0,
            }));
          const more = older.length > 0;
          if (more) loadMoreRef.current.count = nextCount;
          params.callback(older, more);
        })
        .catch(() => params.callback([], false))
        .finally(() => {
          loadMoreRef.current.busy = false;
        });
    });
  }, [accountId, symbol, timeframe]);

  // ── Real-time: drive the last candle from the live tick so the chart moves
  //    continuously (like TradingView) instead of only on the 30s poll. ──────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !liveTick || candles.length === 0) return;
    const last = candles[candles.length - 1];
    const price = liveTick.last || liveTick.bid;
    if (!last || !(price > 0)) return;
    chart.updateData({
      timestamp: last.time,
      open: last.open,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
      volume: last.volume ?? 0,
    });
  }, [liveTick, candles]);

  // Open the TP/SL editor for a position, optionally seeding a dragged value.
  const openEditPosition = useCallback(
    (pos: CopyTradingPosition, overrides?: { tp?: number; sl?: number }) => {
      setEditPos(pos);
      // Show only what the position actually has (or a value the user just
      // dragged). No auto-filled defaults — the user sets their own levels.
      const tpVal = overrides?.tp ?? (pos.tp && pos.tp > 0 ? pos.tp : undefined);
      const slVal = overrides?.sl ?? (pos.sl && pos.sl > 0 ? pos.sl : undefined);
      setEditTp(tpVal != null ? String(tpVal) : '');
      setEditSl(slVal != null ? String(slVal) : '');
    },
    [],
  );

  // Show the green (TP) / amber (SL) zone ONLY while the user is dragging that
  // line — follows the drag via rAF, then clears on release.
  const dragRafRef = useRef<number | null>(null);
  const startDragZone = useCallback((entry: number, overlayId: string, kind: 'tp' | 'sl') => {
    const bg = kind === 'tp' ? 'rgba(46,214,141,0.14)' : 'rgba(227,179,65,0.16)';
    const tick = () => {
      const chart = chartRef.current;
      if (!chart) return;
      const ov = chart.getOverlayById(overlayId);
      const v = ov?.points?.[0]?.value;
      const ec = chart.convertToPixel({ value: entry }, { paneId: CANDLE_PANE_ID });
      const entryY = Array.isArray(ec) ? ec[0]?.y : (ec as { y?: number })?.y;
      if (typeof v === 'number') {
        const vc = chart.convertToPixel({ value: v }, { paneId: CANDLE_PANE_ID });
        const vY = Array.isArray(vc) ? vc[0]?.y : (vc as { y?: number })?.y;
        if (typeof entryY === 'number' && typeof vY === 'number') {
          setPosZones([{ id: 'drag', top: Math.min(entryY, vY), height: Math.abs(vY - entryY), bg }]);
        }
      }
      dragRafRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);
  const stopDragZone = useCallback(() => {
    if (dragRafRef.current) cancelAnimationFrame(dragRafRef.current);
    dragRafRef.current = null;
    setPosZones([]);
  }, []);

  // ── Position lines: plain horizontal lines (no built-in price label — our
  //    own TP/SL/ENTRY tags render on the right). Double-click any line OR drag
  //    a TP/SL line to open the editor. ─────────────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.removeOverlay({ groupId: 'positions' });
    if (!showPositions) return;

    for (const pos of symbolPositions) {
      chart.createOverlay({
        name: 'horizontalStraightLine',
        groupId: 'positions',
        // Not locked: a locked overlay ignores ALL events in klinecharts, which
        // would block the double-click. The entry isn't meant to move, so any
        // drag just reopens the editor (no override) and snaps back on refresh.
        points: [{ value: pos.avgPrice }],
        styles: { line: { color: 'rgba(226,228,233,0.6)', style: LineType.Dashed } },
        onDoubleClick: () => { openEditPosition(pos); return false; },
        onPressedMoveEnd: () => { openEditPosition(pos); return false; },
      });

      const makeStopLine = (kind: StopEditKind, price: number, color: string) =>
        chart.createOverlay({
          name: 'horizontalStraightLine',
          groupId: 'positions',
          points: [{ value: price }],
          styles: { line: { color, style: LineType.Dashed } },
          onDoubleClick: () => { openEditPosition(pos); return false; },
          onPressedMoveStart: (event: OverlayEvent) => {
            // Show the colored zone only while dragging this line.
            startDragZone(pos.avgPrice, event.overlay.id, kind);
            return false;
          },
          onPressedMoveEnd: (event: OverlayEvent) => {
            stopDragZone();
            const next = event.overlay.points?.[0]?.value;
            if (typeof next === 'number' && Number.isFinite(next) && next > 0) {
              openEditPosition(pos, kind === 'tp' ? { tp: next } : { sl: next });
            }
            return false;
          },
        });

      if (showTpSl && pos.tp && pos.tp > 0) makeStopLine('tp', pos.tp, '#2ed68d');
      if (showTpSl && pos.sl && pos.sl > 0) makeStopLine('sl', pos.sl, '#ef5350');
    }
  }, [symbolPositions, openEditPosition, startDragZone, stopDragZone, showPositions, showTpSl]);

  // ── TP/SL/ENTRY labels (HTML overlay positioned at each line, TradingView-
  //    style) — recomputed on pan/zoom/resize/data via convertToPixel. ───────
  const recomputeLabels = useCallback(() => {
    const chart = chartRef.current;
    if (!chart || symbolPositions.length === 0) {
      setPosLabels((prev) => (prev.length ? [] : prev));
      setPosZones((prev) => (prev.length ? [] : prev));
      return;
    }
    const toY = (v: number): number | null => {
      const c = chart.convertToPixel({ value: v }, { paneId: CANDLE_PANE_ID });
      const y = Array.isArray(c) ? c[0]?.y : (c as { y?: number })?.y;
      return typeof y === 'number' && Number.isFinite(y) ? y : null;
    };
    const labels: Array<{ id: string; y: number; color: string; label: string }> = [];
    if (showPositions) {
      for (const pos of symbolPositions) {
        const entryY = toY(pos.avgPrice);
        if (entryY != null) labels.push({ id: `${pos.id}-ENTRY`, y: entryY, color: '#aeb6c4', label: `ENTRY ${formatPrice(pos.avgPrice, pricePrecision)}` });
        if (showTpSl && pos.tp && pos.tp > 0) {
          const tpY = toY(pos.tp);
          if (tpY != null) labels.push({ id: `${pos.id}-TP`, y: tpY, color: '#2ed68d', label: `TP ${formatPrice(pos.tp, pricePrecision)}` });
        }
        if (showTpSl && pos.sl && pos.sl > 0) {
          const slY = toY(pos.sl);
          if (slY != null) labels.push({ id: `${pos.id}-SL`, y: slY, color: '#ef5350', label: `SL ${formatPrice(pos.sl, pricePrecision)}` });
        }
      }
    }
    setPosLabels(labels);
  }, [symbolPositions, pricePrecision, showPositions, showTpSl]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const cb = () => recomputeLabels();
    chart.subscribeAction(ActionType.OnScroll, cb);
    chart.subscribeAction(ActionType.OnZoom, cb);
    chart.subscribeAction(ActionType.OnVisibleRangeChange, cb);
    recomputeLabels();
    return () => {
      chart.unsubscribeAction(ActionType.OnScroll, cb);
      chart.unsubscribeAction(ActionType.OnZoom, cb);
      chart.unsubscribeAction(ActionType.OnVisibleRangeChange, cb);
    };
  }, [recomputeLabels]);

  // Price scale shifts when new candles arrive — reposition the labels.
  useEffect(() => {
    recomputeLabels();
  }, [candles, recomputeLabels]);

  // ── Drawing tools ───────────────────────────────────────────────────────
  const handleToolClick = useCallback((tool: DrawingTool) => {
    const chart = chartRef.current;
    if (!chart) return;
    if (tool.id === 'magnet') {
      setMagnet((m) => !m);
      return;
    }
    if (tool.id === 'clear') {
      chart.removeOverlay({ groupId: 'drawings' });
      setActiveTool('cursor');
      return;
    }
    if (!tool.overlay) {
      setActiveTool('cursor');
      return;
    }
    chart.createOverlay({
      name: tool.overlay,
      groupId: 'drawings',
      // Snap to candle OHLC when the magnet is enabled.
      mode: magnet ? OverlayMode.WeakMagnet : OverlayMode.Normal,
      // Right-click a drawing to delete just that one.
      onRightClick: (e: OverlayEvent) => {
        chartRef.current?.removeOverlay({ id: e.overlay.id });
        return false;
      },
    });
    setActiveTool(tool.id);
  }, [magnet]);

  // ── Indicators ──────────────────────────────────────────────────────────
  const toggleIndicator = useCallback((name: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    const existingPane = indicatorPanesRef.current.get(name);
    if (existingPane) {
      chart.removeIndicator(existingPane, name);
      indicatorPanesRef.current.delete(name);
      setActiveIndicators((prev) => prev.filter((i) => i !== name));
      return;
    }
    const defaultParams = INDICATOR_DEFAULT_PARAMS[name];
    const paneId = chart.createIndicator(
      defaultParams ? { name, calcParams: defaultParams } : name,
      true,
      MAIN_PANE_INDICATORS.has(name) ? { id: CANDLE_PANE_ID } : undefined,
    );
    if (paneId) {
      indicatorPanesRef.current.set(name, paneId);
      setActiveIndicators((prev) => [...prev, name]);
    }
  }, []);

  const handleTakeScreenshot = useCallback(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const url = chart.getConvertPictureUrl(true, 'jpeg', '#0a0c12');
    const link = document.createElement('a');
    link.download = `${symbol || 'chart'}-${timeframe}.jpeg`;
    link.href = url;
    link.click();
  }, [symbol, timeframe]);

  const saveStops = useCallback(async () => {
    if (!editPos || !accountId) return;
    const tp = parseFloat(editTp);
    const sl = parseFloat(editSl);
    const isBuy = editPos.side === 'LONG';
    const ref = editPos.currentPrice || editPos.avgPrice;

    // Validate the levels are on the correct side BEFORE hitting the broker —
    // MT5 rejects "wrong side" stops with a cryptic modify_rejected error.
    if (tp > 0 && ref > 0) {
      if (isBuy && tp <= ref) {
        toast.error('Take Profit inválido', { description: `En una compra, el TP debe estar POR ENCIMA del precio actual (${formatPrice(ref, pricePrecision)}).` });
        return;
      }
      if (!isBuy && tp >= ref) {
        toast.error('Take Profit inválido', { description: `En una venta, el TP debe estar POR DEBAJO del precio actual (${formatPrice(ref, pricePrecision)}).` });
        return;
      }
    }
    if (sl > 0 && ref > 0) {
      if (isBuy && sl >= ref) {
        toast.error('Stop Loss inválido', { description: `En una compra, el SL debe estar POR DEBAJO del precio actual (${formatPrice(ref, pricePrecision)}).` });
        return;
      }
      if (!isBuy && sl <= ref) {
        toast.error('Stop Loss inválido', { description: `En una venta, el SL debe estar POR ENCIMA del precio actual (${formatPrice(ref, pricePrecision)}).` });
        return;
      }
    }

    setSavingStops(true);
    try {
      await updateStops.mutateAsync({
        tradingAccountId: accountId,
        ticket: String(editPos.id),
        stopLoss: sl > 0 ? sl : 0,
        takeProfit: tp > 0 ? tp : 0,
        dryRun: false,
        confirmationText: REAL_CONFIRMATION_TEXT,
      });
      toast.success('TP/SL actualizado', {
        description: `${formatSymbolDisplay(editPos.symbol)} #${editPos.id}`,
      });
      setEditPos(null);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const friendly = /modify_rejected|invalid_stops|10016|too close|trade_disabled|503/i.test(raw)
        ? 'El broker rechazó los niveles: revisa que el SL/TP esté del lado correcto y no demasiado cerca del precio.'
        : raw;
      toast.error('No se pudo actualizar TP/SL', { description: friendly });
    } finally {
      setSavingStops(false);
    }
  }, [accountId, editPos, editTp, editSl, updateStops, pricePrecision]);

  const filteredIndicators = Object.entries(INDICATOR_CATEGORIES as Record<string, readonly string[]>).reduce<Record<string, string[]>>((acc, [category, indicators]) => {
    const filtered = (indicators as readonly string[]).filter(ind =>
      ind.toLowerCase().includes(indicatorSearch.toLowerCase())
    );
    if (filtered.length > 0) acc[category] = filtered;
    return acc;
  }, {});

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-[#0a0c12]', className)}>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Drawing tools */}
        <div className="hidden w-11 shrink-0 flex-col items-center gap-1 border-r border-[#202634]/70 bg-[#0d0f16] py-2 sm:flex">
          {DRAWING_TOOLS.map((tool) => {
            if (tool.separator) {
              return <div key={tool.id} className="my-0.5 h-px w-6 bg-[#202634]/70" />;
            }
            const isActive = tool.id === 'magnet' ? magnet : activeTool === tool.id;
            const Icon = tool.icon;
            const activeColor = tool.danger ? 'text-[#ef5350] bg-[#ef5350]/12' : 'text-[#2f6bff] bg-[#2f6bff]/12';
            return (
              <button
                key={tool.id}
                onClick={() => handleToolClick(tool)}
                title={tool.label}
                className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-md text-[#828b9c] transition-colors hover:bg-[#1a2230] hover:text-[#e7ebf2]',
                  isActive && activeColor,
                )}
              >
                {Icon && <Icon className="h-[17px] w-[17px]" strokeWidth={1.8} />}
              </button>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <div className="flex min-h-[52px] flex-wrap items-center gap-2 border-b border-[#202634]/70 bg-[#0d0f16] px-3 py-2 sm:flex-nowrap sm:gap-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded border border-[#202634]/70 bg-[#151824]">
                <span className="text-[11px] font-bold text-[#e7ebf2]">{symbol?.slice(0, 2).toUpperCase() || '—'}</span>
              </div>
              <div>
                <div className="text-[13px] font-semibold text-[#e7ebf2]">{symbol ? formatSymbolDisplay(symbol) : '—'}</div>
                <div className="flex items-center gap-1">
                  <span className="font-mono text-[15px] font-bold text-[#e7ebf2] tabular-nums">
                    {formatPrice(liveTick?.last || liveTick?.bid || lastCandle?.close, pricePrecision)}
                  </span>
                  {priceChangePct !== null ? (
                    <span className={cn('flex items-center gap-0.5 text-[11px] font-semibold', isPositive ? 'text-[#2ed68d]' : 'text-[#ef5350]')}>
                      {isPositive ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                      {isPositive ? '+' : ''}{priceChangePct.toFixed(2)}%
                    </span>
                  ) : (
                    <span className="text-[11px] text-[#6c7484]">—</span>
                  )}
                </div>
              </div>
            </div>

            <div className="h-6 w-px bg-[#202634]/70" />

            {/* Timeframes */}
            <div className="order-last flex w-full items-center gap-0.5 overflow-x-auto rounded bg-[#151824] p-0.5 sm:order-none sm:w-auto" style={{ scrollbarWidth: "none" }}>
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  className={cn(
                    'rounded px-2 py-1 text-[10px] font-bold transition-colors',
                    timeframe === tf
                      ? 'bg-[#2f6bff]/15 text-[#2f6bff]'
                      : 'text-[#6c7484] hover:bg-[#1a2230] hover:text-[#e7ebf2]'
                  )}
                >
                  {tf}
                </button>
              ))}
            </div>

            <div className="flex-1" />

            <div className="flex items-center gap-0.5">
              {activeIndicators.length > 0 && (
                <span className="hidden rounded bg-[#2ed68d]/10 px-1.5 py-0.5 text-[9px] font-semibold text-[#2ed68d] xl:inline">
                  {activeIndicators.length} ind.
                </span>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => chartRef.current?.removeOverlay({ groupId: 'drawings' })}
                className="h-7 px-2 text-[#6c7484] hover:bg-[#1a2230] hover:text-[#e7ebf2]"
                title="Borrar dibujos"
              >
                <Eraser className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleTakeScreenshot}
                className="h-7 px-2 text-[#6c7484] hover:bg-[#1a2230] hover:text-[#e7ebf2]"
                title="Captura"
              >
                <Camera className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowIndicators(true)}
                className="h-7 gap-1 px-2 text-[#6c7484] hover:bg-[#1a2230] hover:text-[#e7ebf2]"
              >
                <BarChart2 className="h-3 w-3" />
                <span className="hidden text-[10px] xl:inline">Indicadores</span>
              </Button>
            </div>
          </div>

          {/* Chart Area */}
          <div className="relative min-h-0 flex-1 bg-[#0a0c12]">
            <div ref={containerRef} className="absolute inset-0" />
            {/* Profit (green) / loss (red) zones between entry and TP/SL */}
            {posZones.map((z) => (
              <div
                key={z.id}
                className="pointer-events-none absolute left-0 right-[60px] z-[6]"
                style={{ top: z.top, height: z.height, background: z.bg }}
              />
            ))}
            {/* TP/SL/ENTRY labels pinned to each price line (TradingView/Exness style) */}
            {posLabels.map((l) => (
              <div
                key={l.id}
                className="pointer-events-none absolute right-[60px] z-20 -translate-y-1/2 rounded border bg-[#0d0f16]/95 px-1.5 py-[1px] font-mono text-[10px] font-semibold whitespace-nowrap"
                style={{ top: l.y, borderColor: l.color, color: l.color }}
              >
                {l.label}
              </div>
            ))}
            {tfInput !== null && (
              <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded-md border border-[#2f6bff]/40 bg-[#0d0f16]/95 px-4 py-2 text-center shadow-lg">
                <p className="text-[10px] uppercase tracking-wider text-white/40">Temporalidad</p>
                <p className="font-mono text-lg font-semibold text-[#e7ebf2]">{tfInput || "…"}</p>
                <p className="text-[9px] text-white/35 mt-0.5">Enter para aplicar</p>
              </div>
            )}
            {loadingCandles && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0a0c12]/90">
                <div className="text-center space-y-2">
                  <div className="h-6 w-6 border-2 border-[#2f6bff]/30 border-t-[#2f6bff] rounded-full animate-spin mx-auto" />
                  <p className="text-[11px] text-[#6c7484]">Cargando velas...</p>
                </div>
              </div>
            )}
            {!loadingCandles && candlesError && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0a0c12]/90">
                <div className="text-center space-y-2 max-w-xs">
                  <AlertCircle className="h-6 w-6 text-[#ef5350] mx-auto" />
                  <p className="text-[12px] text-[#ef5350] font-medium">Sin datos de mercado disponibles</p>
                </div>
              </div>
            )}
            {!loadingCandles && !candlesError && candles.length === 0 && accountId && symbol && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0a0c12]/90">
                <div className="text-center space-y-2 max-w-xs">
                  <AlertCircle className="h-6 w-6 text-[#6c7484] mx-auto" />
                  <p className="text-[12px] font-semibold text-[#e7ebf2]">Sin datos para {symbol}</p>
                  <p className="text-[10px] text-[#6c7484]">Este símbolo no tiene datos en {timeframe}</p>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-[#202634]/70 bg-[#0d0f16] px-3 py-1.5 text-[9px] text-[#6c7484]">
            <div className="flex items-center gap-2">
              <span className="font-mono">Última: {formatCandleTime(lastCandleTime)}</span>
            </div>
            <div className="flex items-center gap-2 font-mono">
              <span>{timeframe}</span>
              <span className="text-[#6c7484]/50">·</span>
              <span className="text-[#6c7484]/50">{candles.length} velas</span>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={showIndicators} onOpenChange={setShowIndicators}>
        <DialogContent className="max-w-md border-[#202634]/70 bg-[#0d0f16]">
          <DialogHeader>
            <DialogTitle className="text-[#e7ebf2]">Indicadores</DialogTitle>
            <DialogDescription className="sr-only">
              Activa o desactiva indicadores técnicos sobre el gráfico.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Buscar indicador..."
              value={indicatorSearch}
              onChange={(e) => setIndicatorSearch(e.target.value)}
              className="border-[#202634]/70 bg-[#151824] text-[#e7ebf2] placeholder:text-[#6c7484]"
            />
            <div className="max-h-[300px] overflow-y-auto space-y-3">
              {Object.entries(filteredIndicators).map(([category, indicators]) => (
                <div key={category}>
                  <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#6c7484]">{category}</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {indicators.map((indicator) => (
                      <button
                        key={indicator}
                        onClick={() => toggleIndicator(indicator)}
                        className={cn(
                          'px-2 py-1 rounded text-[11px] transition-colors',
                          activeIndicators.includes(indicator)
                            ? 'bg-[#2ed68d]/20 text-[#2ed68d] border border-[#2ed68d]/30'
                            : 'border border-[#202634]/70 bg-[#151824] text-[#6c7484] hover:bg-[#1a2230] hover:text-[#e7ebf2]'
                        )}
                      >
                        {indicator}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editPos)} onOpenChange={(open) => !open && setEditPos(null)}>
        <DialogContent className="max-w-sm border-[#202634]/70 bg-[#0d0f16] p-0 text-[#e7ebf2] overflow-hidden">
          <DialogTitle className="sr-only">Modificar posición</DialogTitle>
          <DialogDescription className="sr-only">
            Ajusta el Take Profit y el Stop Loss de la posición seleccionada.
          </DialogDescription>
          {editPos && (() => {
            const entry = editPos.avgPrice;
            const dec = entry > 0 && entry < 20 ? 5 : 2;
            const pipSz = entry >= 1000 ? 0.1 : entry >= 20 ? 0.01 : 0.0001;
            const step = pipSz * 10;
            const usdPerPrice = editPos.currentPrice !== entry ? editPos.openPnlUsd / (editPos.currentPrice - entry) : null;
            const icon = symbolIcon(editPos.symbol);
            const isBuy = editPos.side === 'LONG';
            const delta = (raw: string) => {
              const v = parseFloat(raw);
              if (!(v > 0)) return null;
              const diff = v - entry;
              return {
                pips: diff / pipSz,
                usd: usdPerPrice != null ? diff * usdPerPrice : null,
                pct: entry ? (diff / entry) * 100 : 0,
              };
            };
            const bump = (cur: string, dir: 1 | -1) => ((parseFloat(cur) || entry) + dir * step).toFixed(dec);
            const fmtDelta = (d: ReturnType<typeof delta>, positive: boolean) => {
              if (!d) return null;
              const sign = (n: number) => (n >= 0 ? '+' : '');
              const col = positive ? 'text-[#2ed68d]' : 'text-[#ef5350]';
              return (
                <div className={cn('mt-1.5 flex gap-2 text-[11px] font-mono', col)}>
                  <span>{sign(d.pips)}{d.pips.toFixed(1)} pips</span>
                  <span className="text-white/25">|</span>
                  <span>{d.usd != null ? `${d.usd >= 0 ? '+' : '-'}$${Math.abs(d.usd).toFixed(2)}` : '—'}</span>
                  <span className="text-white/25">|</span>
                  <span>{sign(d.pct)}{d.pct.toFixed(2)}%</span>
                </div>
              );
            };
            const tpD = delta(editTp);
            const slD = delta(editSl);
            const Field = ({ label, color, value, set, deltaNode }: { label: string; color: string; value: string; set: (v: string) => void; deltaNode: ReactNode }) => (
              <div className="px-4 pt-3">
                <div className="mb-1.5 text-[11px] font-semibold" style={{ color }}>{label}</div>
                <div className="flex items-center gap-2 rounded-lg border bg-[#151824] px-2" style={{ borderColor: `${color}40` }}>
                  <input
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    placeholder="No establecido"
                    className="h-10 flex-1 bg-transparent text-[15px] font-mono text-[#e7ebf2] outline-none placeholder:text-white/30 tabular-nums"
                  />
                  {value && (
                    <button onClick={() => set('')} className="text-white/40 hover:text-white" aria-label="Limpiar">✕</button>
                  )}
                  <button onClick={() => set(bump(value, -1))} className="flex h-7 w-7 items-center justify-center rounded bg-[#0d0f16] text-white/70 hover:text-white">−</button>
                  <button onClick={() => set(bump(value, 1))} className="flex h-7 w-7 items-center justify-center rounded bg-[#0d0f16] text-white/70 hover:text-white">+</button>
                </div>
                {deltaNode}
              </div>
            );
            return (
              <div>
                {/* Header */}
                <div className="flex items-start justify-between gap-3 border-b border-white/10 py-3 pl-4 pr-12">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold" style={{ background: icon.bg, color: icon.fg }}>{icon.glyph}</div>
                    <div>
                      <div className="text-[13px] font-semibold">{formatSymbolDisplay(editPos.symbol)} <span className="text-white/40 font-normal">{editPos.qty} lotes</span></div>
                      <div className="text-[11px]">
                        <span className={isBuy ? 'text-[#2ed68d]' : 'text-[#ef5350]'}>{isBuy ? 'Compra' : 'Venta'}</span>
                        <span className="text-white/40"> en {formatPrice(entry, dec)} · actual {formatPrice(editPos.currentPrice, dec)}</span>
                      </div>
                    </div>
                  </div>
                  <span className={cn('shrink-0 font-mono text-[13px] font-semibold', editPos.openPnlUsd >= 0 ? 'text-[#2ed68d]' : 'text-[#ef5350]')}>
                    {editPos.openPnlUsd >= 0 ? '+' : ''}${editPos.openPnlUsd.toFixed(2)}
                  </span>
                </div>
                <Field label="Take profit" color="#2ed68d" value={editTp} set={setEditTp} deltaNode={fmtDelta(tpD, true)} />
                <Field label="Stop loss" color="#ef5350" value={editSl} set={setEditSl} deltaNode={fmtDelta(slD, false)} />
                <div className="p-4 pt-4">
                  <Button
                    className="h-11 w-full bg-[#2f6bff] text-[14px] font-semibold text-white hover:bg-[#3a64b8]"
                    disabled={savingStops}
                    onClick={() => void saveStops()}
                  >
                    {savingStops ? 'Guardando…' : 'Modificar posición'}
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
