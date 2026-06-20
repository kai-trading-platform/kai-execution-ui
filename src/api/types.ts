// API Types from NestJS Backend
// Auto-generated types based on backend responses

export interface User {
  id: string;
  email: string;
  username: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface Mt5Account {
  id: string;
  user_id: string;
  account_name: string;
  mt5_account_id: string;
  account_type: string;
  is_default: boolean;
  connection_status: string;
  last_verified_at?: string;
  balance?: number;
  equity?: number;
  created_at: string;
  updated_at: string;
  risk_profile_name: string;
  risk_per_trade: number;
  max_daily_loss: number;
  max_daily_trades: number;
  risk_reward_ratio: number;
  trading_model: string;
  trailing_stop_enabled: boolean;
}

export interface RiskSettings {
  user_id: string;
  profile_name: string;
  risk_per_trade: number;
  max_daily_loss: number;
  max_daily_trades: number;
  balance: number;
  created_at: string;
  updated_at: string;
  trading_mode: string;
  risk_reward_ratio: number;
  execution_mode: string;
  trading_model: string;
}

export interface TradingSignal {
  id: string;
  user_id: string;
  symbol: string;
  signal: string;
  confidence: number;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  indicators?: Record<string, unknown>;
  reasoning?: string;
  explanation?: string;
  created_at: string;
}

export interface SignalOutcome {
  id: string;
  signal_id: string;
  user_id: string;
  outcome: string;
  actual_exit_price?: number;
  profit_loss_percentage?: number;
  exit_reason?: string;
  closed_at?: string;
  created_at: string;
  high_water_mark_pct?: number;
  be_triggered_at?: string;
  max_favorable_price?: number;
  balance_applied: boolean;
  balance_applied_at?: string;
  balance_delta?: number;
}

export interface AutoTradingJob {
  id: string;
  user_id: string;
  symbol: string;
  interval_minutes: number;
  selected_system: string;
  status: string;
  signals_generated: number;
  hold_count: number;
  consecutive_errors?: number;
  last_error_at?: string;
  last_signal_at?: string;
  started_at: string;
  ends_at: string;
  last_evaluation_at?: string;
  engine_status?: string;
  waiting_event?: string;
  created_at: string;
  updated_at: string;
}

export interface CopyFollowSetting {
  id: string;
  user_id: string;
  account_id: string;
  symbol: string;
  follow_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface CopyCommand {
  id: string;
  user_id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface NotificationFeed {
  events: NotificationEvent[];
  risk: NotificationRiskSnapshot;
}

export interface NotificationEvent {
  id: string;
  type: string;
  severity: "success" | "info" | "warning" | "error";
  title: string;
  description: string;
  timestamp: string;
  symbol?: string;
  signal_id?: string;
  account_name?: string;
  account_id?: string;
  mt5_account_id?: string;
  target_path?: string;
}

export interface NotificationRiskSnapshot {
  trading_mode: "DAY_TRADING";
  max_daily_trades: number;
  max_daily_loss: number;
  trades_today: number;
  pnl_today: number;
  trades_limit_reached: boolean;
  loss_limit_reached: boolean;
  window_label: string;
  account_name?: string;
  account_id?: string;
}
