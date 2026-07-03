import type { Period } from '@klinecharts/pro';

/**
 * Períodos que expone el terminal. `text` coincide 1:1 con las claves de
 * timeframe que ya usa el resto de la app (y con `TIMEFRAME_MAP` en
 * useMarketCandles), de modo que se puede pasar `period.text` directo a
 * `fetchCandles(...)`.
 */
export const CHART_PRO_PERIODS: Period[] = [
  { multiplier: 1, timespan: 'minute', text: '1m' },
  { multiplier: 5, timespan: 'minute', text: '5m' },
  { multiplier: 10, timespan: 'minute', text: '10m' },
  { multiplier: 15, timespan: 'minute', text: '15m' },
  { multiplier: 30, timespan: 'minute', text: '30m' },
  { multiplier: 1, timespan: 'hour', text: '1h' },
  { multiplier: 2, timespan: 'hour', text: '2h' },
  { multiplier: 4, timespan: 'hour', text: '4h' },
  { multiplier: 1, timespan: 'day', text: 'D' },
  { multiplier: 1, timespan: 'week', text: 'W' },
  { multiplier: 1, timespan: 'month', text: 'M' },
];

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
