import type { CopyTradingPosition } from "@/modules/copyTrading/types";
import type { TradingPosition } from "@/types/trading";

export function tradingPositionToCopyPosition(
  position: TradingPosition,
  accountName = "MT5",
): CopyTradingPosition {
  return {
    id: position.id,
    connection: "MT5",
    accountId: position.tradingAccountId,
    accountName,
    openedAtIso: position.openedAt,
    symbol: position.symbol,
    side: position.side === "sell" ? "SHORT" : "LONG",
    balanceUsd: null,
    avgPrice: position.entryPrice,
    currentPrice: position.currentPrice,
    tp: position.takeProfit,
    sl: position.stopLoss,
    dayPnlUsd: position.profitLoss,
    openPnlUsd: position.profitLoss,
    qty: position.volume,
    contractSize: 0,
    ratio: 1,
    follow: true,
    protectionStatus: null,
  };
}

export function tradingPositionsToCopyPositions(
  positions: TradingPosition[],
  accountName?: string | null,
): CopyTradingPosition[] {
  return positions.map((position) =>
    tradingPositionToCopyPosition(position, accountName || "MT5"),
  );
}
