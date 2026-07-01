import type { TradingPosition } from "@/types/trading";
import type { CopyTradingPosition } from "@/modules/copyTrading/types";

/**
 * The terminal's UI components (BottomPanel, KaiChart) were originally built
 * around the copy-trading `CopyTradingPosition` shape. The execution API,
 * however, returns the leaner `TradingPosition`. This adapter maps one to the
 * other in a single place so the rest of the app has a consistent view model
 * — and so we don't paper over the mismatch with unsafe `as` casts that
 * silently render NaN/undefined.
 */
export function toUiPosition(
  p: TradingPosition,
  accountName = "",
): CopyTradingPosition {
  return {
    id: String(p.id),
    connection: p.provider ?? "",
    accountId: p.tradingAccountId,
    accountName,
    openedAtIso: p.openedAt ?? null,
    symbol: p.symbol,
    side: p.side === "buy" ? "LONG" : "SHORT",
    balanceUsd: null,
    // The API types these as numbers but can return null at runtime; the UI
    // contract (CopyTradingPosition) is non-null, so coalesce to keep the
    // panel's .toFixed() calls from crashing the whole terminal.
    avgPrice: p.entryPrice ?? 0,
    currentPrice: p.currentPrice ?? 0,
    tp: p.takeProfit,
    sl: p.stopLoss,
    dayPnlUsd: 0,
    openPnlUsd: p.profitLoss ?? 0,
    qty: p.volume ?? 0,
    // contractSize is not provided by the execution API; 0 disables the chart's
    // notional P&L estimate (it falls back to the broker-reported profitLoss).
    contractSize: 0,
    ratio: 0,
    follow: false,
    protectionStatus: null,
  };
}
