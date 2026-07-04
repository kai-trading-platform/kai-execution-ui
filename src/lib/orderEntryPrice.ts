import type { TradingOrderSide } from "@/types/trading";

/**
 * Resolve the reference/entry price a market order will approximately fill at.
 *
 * A BUY lifts the ask, a SELL hits the bid — that quote is the reference the
 * Rithmic futures bridge needs to convert absolute SL/TP levels into the
 * tick-distance bracket it expects (GATE 2). Without it, the bridge misreads an
 * absolute SL/TP as a distance and builds the wrong bracket.
 *
 * The side-specific quote is preferred; if it's unavailable (no live tick on
 * that side) we fall back to the opposite quote, then to `fallback` (the latest
 * candle close). Returns 0 only when nothing usable exists — callers already
 * guard on a positive price before submitting.
 *
 * MT5 ignores this value (the MT5 bridge takes absolute SL/TP directly), so it
 * is safe to attach for every provider.
 */
export function resolveOrderEntryPrice(params: {
  side: TradingOrderSide;
  bid: number;
  ask: number;
  fallback: number;
}): number {
  const { side, bid, ask, fallback } = params;
  const sideQuote = side === "buy" ? ask : bid;
  if (sideQuote > 0) return sideQuote;
  const otherQuote = side === "buy" ? bid : ask;
  if (otherQuote > 0) return otherQuote;
  return fallback > 0 ? fallback : 0;
}
