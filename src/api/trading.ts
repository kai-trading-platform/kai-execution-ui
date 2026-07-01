import { nestAuthFetch } from "@/api/client";
import type {
  ConnectedTradingAccount,
  CloseTradingPositionPayload,
  CloseTradingPositionByPayload,
  CloseTradingPositionByResult,
  CloseTradingPositionResult,
  PlaceTradingOrderPayload,
  PlaceTradingOrderResult,
  TradingPosition,
  UpdateTradingPositionStopsPayload,
  UpdateTradingPositionStopsResult,
} from "@/types/trading";

export function listTradingAccounts(): Promise<ConnectedTradingAccount[]> {
  return nestAuthFetch<ConnectedTradingAccount[]>("/api/trading/accounts");
}

export function listTradingPositions(
  tradingAccountId: string,
): Promise<TradingPosition[]> {
  return nestAuthFetch<TradingPosition[]>(
    `/api/trading/accounts/${encodeURIComponent(tradingAccountId)}/positions`,
  );
}

export function placeTradingOrder(
  payload: PlaceTradingOrderPayload,
): Promise<PlaceTradingOrderResult> {
  return nestAuthFetch<PlaceTradingOrderResult>("/api/trading/orders", {
    method: "POST",
    json: { ...payload, dryRun: false },
    headers: { "Idempotency-Key": crypto.randomUUID() },
  });
}

export function closeTradingPosition(
  payload: CloseTradingPositionPayload,
): Promise<CloseTradingPositionResult> {
  return nestAuthFetch<CloseTradingPositionResult>(
    `/api/trading/positions/${encodeURIComponent(payload.ticket)}/close`,
    {
      method: "POST",
      json: {
        tradingAccountId: payload.tradingAccountId,
        volume: payload.volume ?? undefined,
        dryRun: payload.dryRun === false ? false : true,
        confirmationText: payload.confirmationText,
      },
    },
  );
}

export function closeTradingPositionBy(
  payload: CloseTradingPositionByPayload,
): Promise<CloseTradingPositionByResult> {
  return nestAuthFetch<CloseTradingPositionByResult>(
    `/api/trading/positions/${encodeURIComponent(payload.ticket)}/close-by`,
    {
      method: "POST",
      json: {
        tradingAccountId: payload.tradingAccountId,
        byTicket: payload.byTicket,
        dryRun: payload.dryRun === false ? false : true,
        confirmationText: payload.confirmationText,
      },
    },
  );
}

export function updateTradingPositionStops(
  payload: UpdateTradingPositionStopsPayload,
): Promise<UpdateTradingPositionStopsResult> {
  return nestAuthFetch<UpdateTradingPositionStopsResult>(
    `/api/trading/positions/${encodeURIComponent(payload.ticket)}/stops`,
    {
      method: "PATCH",
      json: {
        tradingAccountId: payload.tradingAccountId,
        stopLoss: payload.stopLoss,
        takeProfit: payload.takeProfit,
        dryRun: payload.dryRun === false ? false : true,
        confirmationText: payload.confirmationText,
      },
    },
  );
}
