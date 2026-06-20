import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { createChart, CrosshairMode, CandlestickSeries, LineStyle } from 'lightweight-charts';
import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts';
import { Camera, Undo2, Redo2, Search, AlertCircle, BarChart2, TrendingUp, TrendingDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { REAL_CONFIRMATION_TEXT } from '@/constants/tradingExecution';
import { useUpdateTradingPositionStops } from '@/hooks/useUpdateTradingPositionStops';
import { useMarketCandles, type MarketCandle } from '@/modules/copyTrading/hooks/useMarketCandles';
import type { CopyTradingPosition } from '@/modules/copyTrading/types';

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', 'D'] as const;
type Timeframe = typeof TIMEFRAMES[number];
type PriceLineRef = ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>;
type StopEditKind = 'tp' | 'sl';

interface PendingStopEdit {
  position: CopyTradingPosition;
  kind: StopEditKind;
  price: number;
}

interface VerticalToolItem {
  id: string;
  label: string;
  icon: string;
  danger?: boolean;
}

const VERTICAL_TOOLS: VerticalToolItem[] = [
  { id: 'cursor', label: 'Cursor / Cruz', icon: '✛' },
  { id: 'separator', label: '', icon: '' },
  { id: 'trendline', label: 'Línea de tendencia', icon: '╱' },
  { id: 'ray', label: 'Línea de rayos', icon: '╱→' },
  { id: 'extended', label: 'Línea extendida', icon: '—' },
  { id: 'hline', label: 'Línea horizontal', icon: '─' },
  { id: 'vline', label: 'Línea vertical', icon: '│' },
  { id: 'separator2', label: '', icon: '' },
  { id: 'channel', label: 'Canal paralelo', icon: '╱╲' },
  { id: 'rectangle', label: 'Rectángulo', icon: '▢' },
  { id: 'separator3', label: '', icon: '' },
  { id: 'fib_retrace', label: 'Fibonacci', icon: 'F' },
  { id: 'separator4', label: '', icon: '' },
  { id: 'text', label: 'Texto', icon: 'T' },
  { id: 'arrow_up', label: 'Flecha arriba', icon: '↑' },
  { id: 'arrow_down', label: 'Flecha abajo', icon: '↓' },
  { id: 'separator5', label: '', icon: '' },
  { id: 'zoom', label: 'Zoom', icon: '🔍' },
  { id: 'clear_all', label: 'Borrar todo', icon: '🗑', danger: true },
];

type VerticalToolId = string;

const INDICATOR_CATEGORIES = {
  Tendencia: ['MA', 'EMA', 'WMA', 'BB', 'Ichimoku', 'PSAR', 'VWAP', 'Supertrend'],
  Osciladores: ['RSI', 'Stoch', 'CCI', 'MFI', 'Williams %R'],
  Volumen: ['Volume', 'OBV', 'VWAP', 'CMF'],
} as const;

interface KaiChartProps {
  symbol?: string | null;
  accountId?: string | null;
  positions?: CopyTradingPosition[];
  timeframe?: string;
  onSymbolChange?: (symbol: string) => void;
  onAccountChange?: (accountId: string) => void;
  onTimeframeChange?: (timeframe: string) => void;
  className?: string;
}

const CHART_OPTIONS = {
  layout: {
    background: { color: '#061625' },
    textColor: 'rgba(226,228,233,0.55)',
    fontSize: 11,
    fontFamily: 'Inter, system-ui, sans-serif',
  },
  grid: {
    vertLines: { color: 'rgba(255,255,255,0.04)' },
    horzLines: { color: 'rgba(255,255,255,0.04)' },
  },
  crosshair: {
    mode: CrosshairMode.Normal,
    vertLine: { color: 'rgba(148,163,184,0.22)', labelBackgroundColor: '#071321' },
    horzLine: { color: 'rgba(148,163,184,0.22)', labelBackgroundColor: '#071321' },
  },
  rightPriceScale: {
    borderColor: 'rgba(255,255,255,0.06)',
  },
  timeScale: {
    borderColor: 'rgba(255,255,255,0.06)',
    timeVisible: true,
    secondsVisible: false,
  },
};

const CANDLESTICK_OPTIONS = {
  upColor: '#00c076',
  downColor: '#ff3b30',
  wickUpColor: 'rgba(0,192,118,0.72)',
  wickDownColor: 'rgba(255,59,48,0.72)',
  borderVisible: false,
};

function formatPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSignedCurrency(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '';
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));
  return `${value >= 0 ? '+' : '-'}${formatted}`;
}

function estimatePositionAmount(position: CopyTradingPosition, price: number): number | null {
  if (!position.contractSize || position.contractSize <= 0 || !position.qty || position.qty <= 0) return null;
  const diff = position.side === 'LONG'
    ? price - position.avgPrice
    : position.avgPrice - price;
  return diff * position.qty * position.contractSize;
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

export function KaiChart({
  symbol,
  accountId,
  positions,
  timeframe: timeframeProp,
  onTimeframeChange,
  className,
}: KaiChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const positionLinesRef = useRef<PriceLineRef[]>([]);
  const [timeframe, setTimeframeState] = useState<Timeframe>(() => normalizeTimeframe(timeframeProp));
  const [activeTool, setActiveTool] = useState<VerticalToolId>('cursor');
  const [showIndicators, setShowIndicators] = useState(false);
  const [indicatorSearch, setIndicatorSearch] = useState('');
  const [activeIndicators, setActiveIndicators] = useState<string[]>([]);
  const [showDrawings, setShowDrawings] = useState(true);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [stopEdit, setStopEdit] = useState<PendingStopEdit | null>(null);
  const [pendingStopEdit, setPendingStopEdit] = useState<PendingStopEdit | null>(null);
  const updateStops = useUpdateTradingPositionStops();

  const { data: candles = [], isLoading: loadingCandles, error: candlesError } = useMarketCandles(
    accountId ?? null,
    symbol ?? null,
    timeframe,
    300
  );

  const symbolPositions = useMemo(() => {
    if (!symbol || !positions) return [];
    return positions.filter(p => p.symbol === symbol);
  }, [symbol, positions]);

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  const hasPriceChange = Boolean(lastCandle && prevCandle && prevCandle.close !== 0);
  const priceChange = hasPriceChange && lastCandle && prevCandle ? lastCandle.close - prevCandle.close : null;
  const priceChangePct = priceChange !== null && prevCandle ? (priceChange / prevCandle.close) * 100 : null;
  const isPositive = priceChange == null || priceChange >= 0;
  const lastCandleTime = lastCandle?.time ?? null;

  const setTimeframe = useCallback((tf: Timeframe) => {
    setTimeframeState(tf);
    onTimeframeChange?.(tf);
  }, [onTimeframeChange]);

  useEffect(() => {
    const nextTimeframe = normalizeTimeframe(timeframeProp);
    if (nextTimeframe !== timeframe) {
      setTimeframeState(nextTimeframe);
    }
  }, [timeframeProp, timeframe]);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      ...CHART_OPTIONS,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });

    const candlestickSeries = chart.addSeries(CandlestickSeries, CANDLESTICK_OPTIONS);
    chart.timeScale().fitContent();

    chartRef.current = chart;
    seriesRef.current = candlestickSeries;

    const handleResize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    };

    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);
    window.addEventListener('resize', handleResize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;

    if (candles.length === 0) {
      seriesRef.current.setData([]);
      return;
    }

    const chartData = candles.map((c: MarketCandle) => ({
      time: (c.time / 1000) as Time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));

    seriesRef.current.setData(chartData);
    chartRef.current?.timeScale().fitContent();

    seriesRef.current?.priceScale().applyOptions({
      scaleMargins: {
        top: 0.08,
        bottom: 0.08,
      },
    });
  }, [candles]);

  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return;

    positionLinesRef.current.forEach((line) => {
      seriesRef.current?.removePriceLine(line);
    });
    positionLinesRef.current = [];

    if (!showDrawings) return;

    for (const pos of symbolPositions) {
      const entryLine = seriesRef.current.createPriceLine({
        price: pos.avgPrice,
        color: 'rgba(226,228,233,0.7)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `ENTRY ${formatPrice(pos.avgPrice)}`,
      });
      positionLinesRef.current.push(entryLine);

      if (pos.tp && pos.tp > 0) {
        const amount = estimatePositionAmount(pos, pos.tp);
        const tpLine = seriesRef.current.createPriceLine({
          price: pos.tp,
          color: '#00c076',
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `TP ${formatPrice(pos.tp)} ${formatSignedCurrency(amount)}`.trim(),
        });
        positionLinesRef.current.push(tpLine);
      }

      if (pos.sl && pos.sl > 0) {
        const amount = estimatePositionAmount(pos, pos.sl);
        const slLine = seriesRef.current.createPriceLine({
          price: pos.sl,
          color: '#ff3b30',
          lineWidth: 1,
          lineStyle: LineStyle.Solid,
          axisLabelVisible: true,
          title: `SL ${formatPrice(pos.sl)} ${formatSignedCurrency(amount)}`.trim(),
        });
        positionLinesRef.current.push(slLine);
      }
    }
  }, [symbolPositions, candles, showDrawings]);

  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) return;

    const handleMove = (param: { point?: { y: number } | null }) => {
      if (!stopEdit || !param.point) return;
      const nextPrice = seriesRef.current?.coordinateToPrice(param.point.y);
      if (typeof nextPrice !== 'number' || !Number.isFinite(nextPrice) || nextPrice <= 0) return;
      setStopEdit((current) => current ? { ...current, price: nextPrice } : current);
    };

    const handleClick = (param: { point?: { y: number } | null }) => {
      if (!stopEdit || !param.point) return;
      const nextPrice = seriesRef.current?.coordinateToPrice(param.point.y);
      if (typeof nextPrice !== 'number' || !Number.isFinite(nextPrice) || nextPrice <= 0) return;
      setPendingStopEdit({ ...stopEdit, price: nextPrice });
      setStopEdit(null);
    };

    chartRef.current.subscribeCrosshairMove(handleMove);
    chartRef.current.subscribeClick(handleClick);
    return () => {
      chartRef.current?.unsubscribeCrosshairMove(handleMove);
      chartRef.current?.unsubscribeClick(handleClick);
    };
  }, [stopEdit]);

  const startStopEdit = useCallback((position: CopyTradingPosition, kind: StopEditKind) => {
    const currentPrice = kind === 'tp' ? position.tp : position.sl;
    setStopEdit({
      position,
      kind,
      price: currentPrice && currentPrice > 0 ? currentPrice : position.avgPrice,
    });
  }, []);

  const confirmStopEdit = useCallback(async () => {
    if (!pendingStopEdit || !accountId) return;
    const { position, kind, price } = pendingStopEdit;
    const stopLoss = kind === 'sl' ? price : position.sl;
    const takeProfit = kind === 'tp' ? price : position.tp;

    if (!stopLoss || !takeProfit || stopLoss <= 0 || takeProfit <= 0) {
      toast.error('TP y SL son requeridos', {
        description: 'La modificación necesita ambos niveles definidos en la posición.',
      });
      return;
    }

    try {
      await updateStops.mutateAsync({
        tradingAccountId: accountId,
        ticket: String(position.id),
        stopLoss,
        takeProfit,
        dryRun: false,
        confirmationText: REAL_CONFIRMATION_TEXT,
      });
      toast.success(kind === 'tp' ? 'TP actualizado' : 'SL actualizado', {
        description: `${position.symbol} #${position.id} → ${formatPrice(price)}`,
      });
      setPendingStopEdit(null);
    } catch (error) {
      toast.error('No se pudo actualizar TP/SL', {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [accountId, pendingStopEdit, updateStops]);

  const handleToolClick = useCallback((toolId: VerticalToolId) => {
    if (toolId === 'clear_all') {
      positionLinesRef.current.forEach((line) => seriesRef.current?.removePriceLine(line));
      positionLinesRef.current = [];
      return;
    }
    setActiveTool(toolId);
  }, []);

  const handleTakeScreenshot = useCallback(() => {
    if (chartRef.current) {
      const canvas = chartRef.current.takeScreenshot();
      if (canvas) {
        const dataUrl = canvas.toDataURL('image/png');
        const link = document.createElement('a');
        link.download = `${symbol || 'chart'}-${timeframe}.png`;
        link.href = dataUrl;
        link.click();
      }
    }
  }, [symbol, timeframe]);

  const handleUndo = useCallback(() => {
    setCanUndo(false);
  }, []);

  const handleRedo = useCallback(() => {
    setCanRedo(false);
  }, []);

  const toggleIndicator = useCallback((indicator: string) => {
    setActiveIndicators(prev =>
      prev.includes(indicator)
        ? prev.filter(i => i !== indicator)
        : [...prev, indicator]
    );
  }, []);

  const filteredIndicators = Object.entries(INDICATOR_CATEGORIES as Record<string, readonly string[]>).reduce<Record<string, string[]>>((acc, [category, indicators]) => {
    const filtered = (indicators as readonly string[]).filter(ind =>
      ind.toLowerCase().includes(indicatorSearch.toLowerCase())
    );
    if (filtered.length > 0) {
      acc[category] = filtered;
    }
    return acc;
  }, {});

  return (
    <div className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-[#061625]', className)}>
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Vertical Tools */}
        <div className="hidden w-10 shrink-0 flex-col items-center gap-0.5 border-r border-[#12364b]/70 bg-[#071321] py-2 sm:flex">
          {VERTICAL_TOOLS.map((tool) => {
            if (tool.id.startsWith('separator')) {
              return <div key={tool.id} className="my-0.5 h-px w-5 bg-[#12364b]/70" />;
            }
            const isActive = activeTool === tool.id;
            const activeColor = tool.danger ? 'text-[#ff3b30] bg-[#ff3b30]/10' : 'text-[#00c076] bg-[#00c076]/10';
            return (
              <button
                key={tool.id}
                onClick={() => handleToolClick(tool.id)}
                title={tool.label}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded text-[10px] text-[#6b7280] transition-colors hover:bg-[#1a1f2e] hover:text-[#e2e4e9]',
                  isActive && activeColor
                )}
              >
                {tool.icon}
              </button>
            );
          })}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header */}
          <div className="flex min-h-[52px] flex-wrap items-center gap-2 border-b border-[#12364b]/70 bg-[#071321] px-3 py-2 sm:flex-nowrap sm:gap-3">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded border border-[#12364b]/70 bg-[#081827]">
                <span className="text-[11px] font-bold text-[#e2e4e9]">{symbol?.slice(0, 2).toUpperCase() || '—'}</span>
              </div>
              <div>
                <div className="text-[13px] font-semibold text-[#e2e4e9]">{symbol || '—'}</div>
                <div className="flex items-center gap-1">
                  <span className="font-mono text-[15px] font-bold text-[#e2e4e9] tabular-nums">
                    {formatPrice(lastCandle?.close)}
                  </span>
                  {priceChangePct !== null ? (
                    <span className={cn('flex items-center gap-0.5 text-[11px] font-semibold', isPositive ? 'text-[#00c076]' : 'text-[#ff3b30]')}>
                      {isPositive ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                      {isPositive ? '+' : ''}{priceChangePct.toFixed(2)}%
                    </span>
                  ) : (
                    <span className="text-[11px] text-[#6b7280]">—</span>
                  )}
                </div>
              </div>
            </div>

            <div className="h-6 w-px bg-[#12364b]/70" />

            {/* Timeframes */}
            <div className="order-last flex w-full items-center gap-0.5 overflow-x-auto rounded bg-[#081827] p-0.5 sm:order-none sm:w-auto" style={{ scrollbarWidth: "none" }}>
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  className={cn(
                    'rounded px-2 py-1 text-[10px] font-bold transition-colors',
                    timeframe === tf
                      ? 'bg-[#3b82f6]/15 text-[#3b82f6]'
                      : 'text-[#6b7280] hover:bg-[#0b2234] hover:text-[#e2e4e9]'
                  )}
                >
                  {tf}
                </button>
              ))}
            </div>

            <div className="flex-1" />

            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleTakeScreenshot}
                className="h-7 px-2 text-[#6b7280] hover:bg-[#0b2234] hover:text-[#e2e4e9]"
                title="Captura"
              >
                <Camera className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowIndicators(true)}
                className="h-7 gap-1 px-2 text-[#6b7280] hover:bg-[#0b2234] hover:text-[#e2e4e9]"
              >
                <BarChart2 className="h-3 w-3" />
                <span className="hidden text-[10px] xl:inline">Indicadores</span>
              </Button>
            </div>
          </div>

          {/* Chart Area */}
          <div className="relative min-h-0 flex-1 bg-[#061625]">
            <div ref={containerRef} className="absolute inset-0" />
            {symbolPositions.length > 0 && (
              <div className="absolute left-3 top-3 z-20 max-w-[340px] space-y-2">
                {symbolPositions.slice(0, 3).map((position) => (
                  <div key={position.id} className="rounded border border-[#12364b]/75 bg-[#071321]/95 p-2">
                    <div className="mb-1.5 flex items-center justify-between gap-3">
                      <span className="truncate text-[11px] font-semibold text-[#e2e4e9]">
                        #{position.id} · {position.side === 'LONG' ? 'BUY' : 'SELL'} · {position.qty} lotes
                      </span>
                      <span className={cn('font-mono text-[10px]', position.openPnlUsd >= 0 ? 'text-[#00c076]' : 'text-[#ff3b30]')}>
                        {formatSignedCurrency(position.openPnlUsd)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        type="button"
                        onClick={() => startStopEdit(position, 'tp')}
                        className="h-7 rounded border border-[#00c076]/25 bg-[#00c076]/10 text-[10px] font-bold text-[#00c076] transition-colors hover:bg-[#00c076]/20"
                      >
                        Mover TP
                      </button>
                      <button
                        type="button"
                        onClick={() => startStopEdit(position, 'sl')}
                        className="h-7 rounded border border-[#ff3b30]/25 bg-[#ff3b30]/10 text-[10px] font-bold text-[#ff3b30] transition-colors hover:bg-[#ff3b30]/20"
                      >
                        Mover SL
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {stopEdit && (
              <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded border border-[#f5c542]/35 bg-[#071321]/95 px-3 py-2 text-center">
                <p className="text-[11px] font-semibold text-[#f5c542]">
                  Mueve el cursor y haz clic para fijar {stopEdit.kind.toUpperCase()}
                </p>
                <p className="font-mono text-[13px] text-[#e2e4e9]">{formatPrice(stopEdit.price)}</p>
              </div>
            )}
            {/* TradingView Watermark - bottom right */}
            <div className="absolute bottom-2 right-2 pointer-events-none select-none text-[#12364b] text-[11px] font-bold uppercase tracking-wider opacity-40">
              TradingView
            </div>
            {loadingCandles && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#061625]/90">
                <div className="text-center space-y-2">
                  <div className="h-6 w-6 border-2 border-[#3b82f6]/30 border-t-[#3b82f6] rounded-full animate-spin mx-auto" />
                  <p className="text-[11px] text-[#6b7280]">Cargando velas...</p>
                </div>
              </div>
            )}
            {!loadingCandles && candlesError && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#061625]/90">
                <div className="text-center space-y-2 max-w-xs">
                  <AlertCircle className="h-6 w-6 text-[#ff3b30] mx-auto" />
                  <p className="text-[12px] text-[#ff3b30] font-medium">Sin datos de mercado disponibles</p>
                </div>
              </div>
            )}
            {!loadingCandles && !candlesError && candles.length === 0 && accountId && symbol && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#061625]/90">
                <div className="text-center space-y-2 max-w-xs">
                  <AlertCircle className="h-6 w-6 text-[#6b7280] mx-auto" />
                  <p className="text-[12px] font-semibold text-[#e2e4e9]">Sin datos para {symbol}</p>
                  <p className="text-[10px] text-[#6b7280]">Este símbolo no tiene datos en {timeframe}</p>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between border-t border-[#12364b]/70 bg-[#071321] px-3 py-1.5 text-[9px] text-[#6b7280]">
            <div className="flex items-center gap-2">
              <span className="font-mono">Última: {formatCandleTime(lastCandleTime)}</span>
            </div>
            <div className="flex items-center gap-2 font-mono">
              <span>{timeframe}</span>
              <span className="text-[#6b7280]/50">·</span>
              <span className="text-[#6b7280]/50">auto</span>
            </div>
          </div>
        </div>
      </div>

      <Dialog open={showIndicators} onOpenChange={setShowIndicators}>
        <DialogContent className="max-w-md border-[#12364b]/70 bg-[#071321]">
          <DialogHeader>
            <DialogTitle className="text-[#e2e4e9]">Indicadores</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Buscar indicador..."
              value={indicatorSearch}
              onChange={(e) => setIndicatorSearch(e.target.value)}
              className="border-[#12364b]/70 bg-[#081827] text-[#e2e4e9] placeholder:text-[#6b7280]"
            />
            <div className="max-h-[300px] overflow-y-auto space-y-3">
              {Object.entries(filteredIndicators).map(([category, indicators]) => (
                <div key={category}>
                  <h4 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[#6b7280]">{category}</h4>
                  <div className="flex flex-wrap gap-1.5">
                    {indicators.map((indicator) => (
                      <button
                        key={indicator}
                        onClick={() => toggleIndicator(indicator)}
                        className={cn(
                          'px-2 py-1 rounded text-[11px] transition-colors',
                          activeIndicators.includes(indicator)
                            ? 'bg-[#00c076]/20 text-[#00c076] border border-[#00c076]/30'
                            : 'border border-[#12364b]/70 bg-[#081827] text-[#6b7280] hover:bg-[#0b2234] hover:text-[#e2e4e9]'
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

      <Dialog open={Boolean(pendingStopEdit)} onOpenChange={(open) => !open && setPendingStopEdit(null)}>
        <DialogContent className="max-w-sm border-[#12364b]/70 bg-[#071321] text-[#e2e4e9]">
          <DialogHeader>
            <DialogTitle className="text-[#e2e4e9]">Confirmar cambio de {pendingStopEdit?.kind.toUpperCase()}</DialogTitle>
          </DialogHeader>
          {pendingStopEdit && (
            <div className="space-y-4">
              <div className="rounded border border-[#12364b]/70 bg-[#061625] p-3 text-[12px]">
                <div className="flex justify-between gap-3">
                  <span className="text-[#8fa1aa]">Posición</span>
                  <span className="font-mono text-[#e2e4e9]">#{pendingStopEdit.position.id}</span>
                </div>
                <div className="mt-2 flex justify-between gap-3">
                  <span className="text-[#8fa1aa]">Nuevo precio</span>
                  <span className="font-mono text-[#e2e4e9]">{formatPrice(pendingStopEdit.price)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void confirmStopEdit()}
                disabled={updateStops.isPending}
                className="flex h-10 w-full items-center justify-center rounded bg-[#00c076] text-[13px] font-bold text-white transition-colors hover:bg-[#00d683] disabled:cursor-wait disabled:opacity-60"
              >
                {updateStops.isPending ? 'Actualizando...' : 'Confirmar'}
              </button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
