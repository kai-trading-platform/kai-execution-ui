import { nestAuthFetch } from "@/api/client";
import type {
  TradingHistoryItem,
  ConnectedTradingAccount,
  CloseTradingPositionPayload,
  CloseTradingPositionByPayload,
  CloseTradingPositionByResult,
  CloseTradingPositionResult,
  CancelAllOrdersPayload,
  CancelAllOrdersResult,
  FlattenAllPositionsPayload,
  FlattenAllPositionsResult,
  PlaceTradingOrderPayload,
  PlaceTradingOrderResult,
  ReversePositionPayload,
  ReversePositionResult,
  TradingOrder,
  TradingPosition,
  UpdateTradingPositionStopsPayload,
  UpdateTradingPositionStopsResult,
} from "@/types/trading";

export function listTradingAccounts(): Promise<ConnectedTradingAccount[]> {
  return nestAuthFetch<ConnectedTradingAccount[]>("/api/trading/accounts");
}

export function listTradingHistory(
  tradingAccountId: string,
): Promise<TradingHistoryItem[]> {
  return nestAuthFetch<TradingHistoryItem[]>(
    `/api/trading/accounts/${encodeURIComponent(tradingAccountId)}/history`,
  );
}

export function listTradingPositions(
  tradingAccountId: string,
): Promise<TradingPosition[]> {
  return nestAuthFetch<TradingPosition[]>(
    `/api/trading/accounts/${encodeURIComponent(tradingAccountId)}/positions`,
  );
}

export function listTradingOrders(
  tradingAccountId: string,
): Promise<TradingOrder[]> {
  return nestAuthFetch<TradingOrder[]>(
    `/api/trading/accounts/${encodeURIComponent(tradingAccountId)}/orders`,
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
        removeStopLoss: payload.removeStopLoss === true,
        removeTakeProfit: payload.removeTakeProfit === true,
        confirmNaked: payload.confirmNaked === true,
      },
    },
  );
}

// FLATTEN ALL — close every position + cancel every working order on the
// account. Safe default: dryRun true unless the caller explicitly passes false
// (mirrors closeTradingPosition). Sends an Idempotency-Key like place/close.
export function flattenAllPositions(
  payload: FlattenAllPositionsPayload,
): Promise<FlattenAllPositionsResult> {
  return nestAuthFetch<FlattenAllPositionsResult>(
    "/api/trading/positions/close-all",
    {
      method: "POST",
      json: {
        tradingAccountId: payload.tradingAccountId,
        dryRun: payload.dryRun === false ? false : true,
        confirmationText: payload.confirmationText,
      },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    },
  );
}

// CANCEL ALL — cancel every working order (positions untouched). Safe default:
// dryRun true unless the caller explicitly passes false.
export function cancelAllOrders(
  payload: CancelAllOrdersPayload,
): Promise<CancelAllOrdersResult> {
  return nestAuthFetch<CancelAllOrdersResult>(
    "/api/trading/orders/cancel-all",
    {
      method: "POST",
      json: {
        tradingAccountId: payload.tradingAccountId,
        dryRun: payload.dryRun === false ? false : true,
        confirmationText: payload.confirmationText,
      },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    },
  );
}

// REVERSE — flip a position (close + open opposite). Money-critical: safe
// default dryRun true; the server requires a protective SL (+ entry) to pass the
// fail-closed per-trade risk gate before a real flip executes.
export function reversePosition(
  payload: ReversePositionPayload,
): Promise<ReversePositionResult> {
  return nestAuthFetch<ReversePositionResult>(
    `/api/trading/positions/${encodeURIComponent(payload.ticket)}/reverse`,
    {
      method: "POST",
      json: {
        tradingAccountId: payload.tradingAccountId,
        stopLoss: payload.stopLoss ?? undefined,
        takeProfit: payload.takeProfit ?? undefined,
        entry: payload.entry ?? undefined,
        dryRun: payload.dryRun === false ? false : true,
        confirmationText: payload.confirmationText,
      },
      headers: { "Idempotency-Key": crypto.randomUUID() },
    },
  );
}
