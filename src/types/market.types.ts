export interface AccountSymbol {
  id: string;
  name: string;
  description: string;
  path: string;
  category: string;
  digits: number;
  currency_base: string;
  currency_profit: string;
  volume_min: number;
  volume_max: number;
  volume_step: number;
  spread: number;
  contract_size: number;
  tick_size: number;
  tick_value: number;
  trade_mode: number;
  synced_at: string;
}

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  time: number;
  spread: number;
}

export interface OHLCVBar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Timeframe = 'M1' | 'M5' | 'M15' | 'M30' | 'H1' | 'H4' | 'D1' | 'W1';
