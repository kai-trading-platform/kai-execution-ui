export type BrokerProviderKey = "mt5" | "rithmic";

export type TradingOrderSide = "buy" | "sell";

export type TradingOrderType = "market";

export interface BrokerCapabilities {
  listAccounts: boolean;
  listPositions: boolean;
  placeMarketOrder: boolean;
  closePosition: boolean;
  closePositionBy?: boolean;
  updateStops: boolean;
  /**
   * Futures-terminal bulk/flip actions (Rithmic only). Gated by the same
   * RITHMIC_TERMINAL_ORDERS_ENABLED kill-switch as the other Rithmic writes and
   * by connection status; undefined/false → the button stays disabled.
   */
  flattenAll?: boolean;
  cancelAllOrders?: boolean;
  reversePosition?: boolean;
}

export interface ConnectedTradingAccount {
  id: string;
  provider: BrokerProviderKey;
  providerAccountId: string;
  name: string;
  server: string | null;
  status: string;
  accountType: string;
  isDefault: boolean;
  balance: number | null;
  equity: number | null;
  /**
   * Per-account futures contracts cap from `system_configs` key
   * `autotrading:maxContracts:<accountId>` (matched by account UUID, falling
   * back to the broker login/ref). Undefined when unset/<=0 — no cap. Read by
   * the terminal's cap badge (see TradingTerminal.tsx).
   */
  maxContracts?: number;
  /** Balance al inicio del día de trading actual (18:00 ET). */
  sodBalance?: number | null;
  /** PnL realizado del día de trading actual. */
  netDailyPnl?: number | null;
  capabilities: BrokerCapabilities;
}

export interface TradingPosition {
  id: string;
  tradingAccountId: string;
  provider: BrokerProviderKey;
  symbol: string;
  side: TradingOrderSide;
  volume: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  profitLoss: number;
  openedAt: string | null;
  comment?: string | null;
  magic?: number | null;
}

export interface TradingHistoryItem {
  id: string;
  /** Ticket del broker (BigInt serializado como string); opcional para
   * tolerar respuestas del API sin el campo. */
  ticket?: string | null;
  tradingAccountId: string;
  provider: BrokerProviderKey;
  symbol: string;
  side: TradingOrderSide;
  volume: number;
  entryPrice: number;
  exitPrice: number | null;
  /** SL/TP con los que se abrió el trade — para dibujar la caja LONG/SHORT. */
  stopLoss: number | null;
  takeProfit: number | null;
  profitLoss: number | null;
  openedAt: string | null;
  closedAt: string | null;
  /** Origen del cierre (KAI_META closeSource: 'manual_kai'/'manual_mt5'/...);
   * opcional para tolerar respuestas del API sin el campo. */
  closeSource?: string | null;
  /** Razón del cierre (KAI_META reason, p.ej. DEAL_REASON_CLIENT). */
  closeReason?: string | null;
  /** Salidas parciales (scale-out / multi-TP) desde KAI_META; null/ausente si
   * cerró de una. Solo viene poblado con MÁS de un tramo. La tabla Ejecutadas las
   * despliega al hacer click en el nº de contratos. */
  partials?: PartialExit[] | null;
}

/** Una salida PARCIAL de un trade que cerró en tramos (scale-out / multi-TP). */
export interface PartialExit {
  price: number;
  qty: number;
  pnl: number;
  at: string;
}

/** Clase de una orden pendiente (a qué precio dispara). */
export type TradingOrderKind = "limit" | "stop" | "stop_limit" | "other";

/** Orden PENDIENTE (working order): colocada pero aún no ejecutada. */
export interface TradingOrder {
  id: string;
  tradingAccountId: string;
  provider: BrokerProviderKey;
  symbol: string;
  side: TradingOrderSide;
  type: TradingOrderKind;
  volume: number;
  price: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  placedAt: string | null;
  comment?: string | null;
  magic?: number | null;
}

export interface PlaceTradingOrderPayload {
  tradingAccountId: string;
  symbol: string;
  side: TradingOrderSide;
  type?: TradingOrderType;
  volume: number;
  stopLoss: number;
  takeProfit: number;
  /**
   * Reference/entry price (absolute) a market order will approximately fill at
   * (BUY→ask, SELL→bid). Rithmic futures needs it to convert absolute SL/TP into
   * the tick-distance bracket the bridge expects; MT5 ignores it.
   */
  entry?: number;
  comment?: string | null;
  magic?: number | null;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface PlaceTradingOrderResult {
  ok: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  orderId?: string | null;
  raw?: unknown;
  message?: string;
  dryRun?: boolean;
}

export interface CloseTradingPositionPayload {
  tradingAccountId: string;
  ticket: string;
  volume?: number | null;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface CloseTradingPositionByPayload {
  tradingAccountId: string;
  ticket: string;
  byTicket: string;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface CloseTradingPositionResult {
  success: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  ticket: string;
  message?: string;
  dryRun?: boolean;
}

export interface CloseTradingPositionByResult extends CloseTradingPositionResult {
  byTicket: string;
}

export interface UpdateTradingPositionStopsPayload {
  tradingAccountId: string;
  ticket: string;
  stopLoss: number;
  takeProfit: number;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface UpdateTradingPositionStopsResult {
  success: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  ticket: string;
  stopLoss: number;
  takeProfit: number;
  message?: string;
  dryRun?: boolean;
}

export interface FlattenAllPositionsPayload {
  tradingAccountId: string;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface FlattenAllPositionsResult {
  success: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  message?: string;
  dryRun?: boolean;
}

export interface CancelAllOrdersPayload {
  tradingAccountId: string;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface CancelAllOrdersResult {
  success: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  message?: string;
  dryRun?: boolean;
}

export interface ReversePositionPayload {
  tradingAccountId: string;
  ticket: string;
  /**
   * Absolute SL/TP/entry for the NEW (reversed) position. The Rithmic per-trade
   * risk gate is fail-closed and REQUIRES an SL (+ entry) to bound the flip's
   * loss — a reverse without a protective SL is refused server-side by design.
   */
  stopLoss?: number | null;
  takeProfit?: number | null;
  entry?: number | null;
  dryRun?: boolean;
  confirmationText?: string | null;
}

export interface ReversePositionResult {
  success: boolean;
  provider: BrokerProviderKey;
  tradingAccountId: string;
  ticket: string;
  message?: string;
  dryRun?: boolean;
}
