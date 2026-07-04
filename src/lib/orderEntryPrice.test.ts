import { describe, expect, it } from "vitest";

import { resolveOrderEntryPrice } from "./orderEntryPrice";

describe("resolveOrderEntryPrice", () => {
  it("uses the ask for a BUY (the price a market buy fills at)", () => {
    expect(
      resolveOrderEntryPrice({ side: "buy", bid: 20000.25, ask: 20000.75, fallback: 19999 }),
    ).toBe(20000.75);
  });

  it("uses the bid for a SELL (the price a market sell fills at)", () => {
    expect(
      resolveOrderEntryPrice({ side: "sell", bid: 20000.25, ask: 20000.75, fallback: 19999 }),
    ).toBe(20000.25);
  });

  it("falls back to the opposite quote when the side-specific quote is missing", () => {
    // BUY but no ask → use the bid.
    expect(
      resolveOrderEntryPrice({ side: "buy", bid: 20000, ask: 0, fallback: 19999 }),
    ).toBe(20000);
    // SELL but no bid → use the ask.
    expect(
      resolveOrderEntryPrice({ side: "sell", bid: 0, ask: 20000.75, fallback: 19999 }),
    ).toBe(20000.75);
  });

  it("falls back to the fallback (candle close) when neither side quote is available", () => {
    expect(
      resolveOrderEntryPrice({ side: "buy", bid: 0, ask: 0, fallback: 19999.5 }),
    ).toBe(19999.5);
    expect(
      resolveOrderEntryPrice({ side: "sell", bid: 0, ask: 0, fallback: 19999.5 }),
    ).toBe(19999.5);
  });

  it("returns 0 when nothing usable is available", () => {
    expect(
      resolveOrderEntryPrice({ side: "buy", bid: 0, ask: 0, fallback: 0 }),
    ).toBe(0);
  });
});

// This describes the payload contract handlePlaceOrder relies on: the SAME
// payload shape is built for every provider (there is no provider branch in
// handlePlaceOrder), and `entry` is computed BUY→ask / SELL→bid. The Rithmic
// futures bridge consumes `entry`; MT5 ignores it server-side, so MT5 order
// behaviour is unchanged. This mirrors the exact expression used in the panel.
describe("order payload entry wiring (as used by handlePlaceOrder)", () => {
  const buildEntry = (
    side: "buy" | "sell",
    bidPrice: number,
    askPrice: number,
    fallbackPrice: number,
  ) => {
    const entry = resolveOrderEntryPrice({ side, bid: bidPrice, ask: askPrice, fallback: fallbackPrice });
    return entry > 0 ? entry : undefined;
  };

  it("attaches entry = ask for a futures BUY", () => {
    expect(buildEntry("buy", 20000.25, 20000.75, 19999)).toBe(20000.75);
  });

  it("attaches entry = bid for a futures SELL", () => {
    expect(buildEntry("sell", 20000.25, 20000.75, 19999)).toBe(20000.25);
  });

  it("uses the fallback price when there is no live tick (both sides default to it)", () => {
    // In the component bidPrice/askPrice already default to fallbackPrice when
    // no tick exists, so the side quote equals the fallback.
    expect(buildEntry("buy", 19999, 19999, 19999)).toBe(19999);
    expect(buildEntry("sell", 19999, 19999, 19999)).toBe(19999);
  });

  it("omits entry (undefined) when no price is known — MT5 payload stays free of a bogus entry", () => {
    expect(buildEntry("buy", 0, 0, 0)).toBeUndefined();
  });
});
