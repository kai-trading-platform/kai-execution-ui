export type CopyTradingPositionSide = "LONG" | "SHORT";

export interface CopyTradingPosition {
  id: string;
  connection: string;
  accountId: string;
  accountName: string;
  openedAtIso: string | null;
  symbol: string;
  side: CopyTradingPositionSide;
  balanceUsd: number | null;
  avgPrice: number;
  currentPrice: number;
  tp: number | null;
  sl: number | null;
  dayPnlUsd: number;
  openPnlUsd: number;
  qty: number;
  contractSize: number;
  ratio: number;
  follow: boolean;
  isFollower?: boolean;
  protectionStatus: string | null;
}

export type CopyTradingOrderStatus = "open" | "filled" | "canceled" | "failed";
export type CopyTradingOrderFilter = "all" | CopyTradingOrderStatus;
export type CopyTradingCommandType =
  | "flatten"
  | "flatten_all"
  | "cancel_orders"
  | "disable_followers";

export interface CopyTradingOrder {
  id: string;
  connection: string;
  accountName: string;
  accountId: string;
  timeIso: string;
  contract: string;
  type: "Market" | "Limit" | "Stop";
  side: CopyTradingPositionSide;
  qty: number;
  price: number;
  tp: number | null;
  sl: number | null;
  pnlUsd: number | null;
  status: CopyTradingOrderStatus;
  closePrice?: number | null;
  closeReason?: string | null;
  closeSource?: "manual_kai" | "manual_mt5" | "strategy_auto" | "broker_system" | "unknown" | null;
}

export interface CopyTradingCommandPayload {
  accountId?: string;
  positionId?: string;
  symbol?: string;
  contract?: string;
  scope?: "all" | "filtered";
  accountIds?: string[];
}

export type CopyTradingAccountStatus = "available" | "locked";
export type CopyTradingRiskStatus = "ready" | "missing_snapshot" | "missing_balance";

export interface CopyTradingAccountSummary {
  id: string;
  accountSource?: "mt5_accounts" | "trading_accounts";
  providerKey?: "mt5_bridge" | "tradovate" | "topstepx";
  connectionId: string;
  connectionName: string;
  provider: string;
  label?: string | null;
  propFirm?: string | null;
  externalAccountId?: string | null;
  connectionStatus?: "connected" | "pending" | "error" | "attention_required" | "disconnected";
  lastError?: string | null;
  accountName: string;
  mt5AccountId?: string | null;
  balanceUsd: number | null;
  equityUsd?: number | null;
  margin?: number | null;
  freeMargin?: number | null;
  floatingPnl?: number | null;
  lastBalanceSyncAt?: string | null;
  riskProfileName?: string | null;
  riskPerTradeUsd?: number | null;
  dailyLossLimitUsd?: number | null;
  dailyProfitTargetUsd?: number | null;
  riskStatus?: CopyTradingRiskStatus;
  riskStatusLabel?: string | null;
  status: CopyTradingAccountStatus;
  manualLocked?: boolean;
  lockRemainingLabel?: string | null;
  isLeader?: boolean;
  groupedWithLeader?: boolean;
}

export interface CopyTradingConnectionGroup {
  id: string;
  connectionName: string;
  provider: string;
  accounts: CopyTradingAccountSummary[];
}

export interface CopyTradingConnectionsPayload {
  leaderAccountId: string | null;
  followerAccountIds: string[];
  groups: CopyTradingConnectionGroup[];
}
