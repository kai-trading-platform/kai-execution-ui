import type { Period } from '@klinecharts/pro';

/**
 * Períodos que expone el terminal. `text` coincide 1:1 con las claves de
 * timeframe que ya usa el resto de la app (y con `TIMEFRAME_MAP` en
 * useMarketCandles), de modo que se puede pasar `period.text` directo a
 * `fetchCandles(...)`.
 */
// Todas las temporalidades que soporta el bridge MT5 (M1..M20, H1..H12, D/W/MN).
export const CHART_PRO_PERIODS: Period[] = [
  { multiplier: 1, timespan: 'minute', text: '1m' },
  { multiplier: 2, timespan: 'minute', text: '2m' },
  { multiplier: 3, timespan: 'minute', text: '3m' },
  { multiplier: 4, timespan: 'minute', text: '4m' },
  { multiplier: 5, timespan: 'minute', text: '5m' },
  { multiplier: 6, timespan: 'minute', text: '6m' },
  { multiplier: 10, timespan: 'minute', text: '10m' },
  { multiplier: 12, timespan: 'minute', text: '12m' },
  { multiplier: 15, timespan: 'minute', text: '15m' },
  { multiplier: 20, timespan: 'minute', text: '20m' },
  { multiplier: 30, timespan: 'minute', text: '30m' },
  { multiplier: 1, timespan: 'hour', text: '1h' },
  { multiplier: 2, timespan: 'hour', text: '2h' },
  { multiplier: 3, timespan: 'hour', text: '3h' },
  { multiplier: 4, timespan: 'hour', text: '4h' },
  { multiplier: 6, timespan: 'hour', text: '6h' },
  { multiplier: 8, timespan: 'hour', text: '8h' },
  { multiplier: 12, timespan: 'hour', text: '12h' },
  { multiplier: 1, timespan: 'day', text: 'D' },
  { multiplier: 1, timespan: 'week', text: 'W' },
  { multiplier: 1, timespan: 'month', text: 'M' },
];

// Subtítulo dinámico del modal "Cambiar Intervalo" (ej. "5" → "5 minutos").
export function timeframeInputLabel(input: string): string {
  const s = input.trim().toUpperCase();
  if (s === "D") return "Día";
  if (s === "W") return "Semana";
  if (s === "M") return "Mes";
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return "…";
  if (n % 60 === 0) {
    const h = n / 60;
    return `${h} ${h === 1 ? "hora" : "horas"}`;
  }
  return `${n} ${n === 1 ? "minuto" : "minutos"}`;
}

// Categorías para el dropdown (Minutos / Horas / Días), estilo TradingView.
export const TIMEFRAME_CATEGORIES: Array<{ label: string; timeframes: string[] }> = [
  { label: "Minutos", timeframes: ["1m", "2m", "3m", "4m", "5m", "6m", "10m", "12m", "15m", "20m", "30m"] },
  { label: "Horas", timeframes: ["1h", "2h", "3h", "4h", "6h", "8h", "12h"] },
  { label: "Días", timeframes: ["D", "W", "M"] },
];

// Atajo de teclado tipo TradingView: escribir un número/letra cambia el TF.
// Mapea la entrada (minutos, o D/W/M) al `text` de un período existente.
export function timeframeFromKeyInput(input: string): string | undefined {
  const s = input.trim().toUpperCase();
  const byMinutes: Record<string, string> = {
    '1': '1m', '2': '2m', '3': '3m', '4': '4m', '5': '5m', '6': '6m',
    '10': '10m', '12': '12m', '15': '15m', '20': '20m', '30': '30m',
    '60': '1h', '120': '2h', '180': '3h', '240': '4h', '360': '6h', '480': '8h', '720': '12h',
  };
  if (byMinutes[s]) return byMinutes[s];
  if (s === 'D' || s === '1D') return 'D';
  if (s === 'W' || s === '1W') return 'W';
  if (s === 'M' || s === '1M') return 'M';
  return undefined;
}

export function periodForTimeframe(tf: string | undefined): Period {
  return CHART_PRO_PERIODS.find((p) => p.text === tf) ?? CHART_PRO_PERIODS[5]; // 1h por defecto
}

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000, // ~30d, aproximado; solo se usa para agrupar ticks en la vela en curso
};

export function periodDurationMs(period: Period): number {
  return (UNIT_MS[period.timespan] ?? 60_000) * period.multiplier;
}
