import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// fetchCandles pulls history for the chart. The endpoint
// (/api/mt5-accounts/:id/rates/:symbol) is provider-transparent on the backend:
// Rithmic (futures) accounts are rows in the same mt5_accounts table and the
// service dispatches to the Rithmic bridge by provider. So the frontend routes a
// Rithmic accountId to the SAME endpoint as an MT5 one — there is nothing to
// branch on client-side. These tests lock that contract (and the timeframe
// mapping) so nobody "fixes" it by forking the URL per provider.
const nestAuthFetch = vi.fn();
vi.mock("@/api/client", () => ({
  nestAuthFetch: (...args: unknown[]) => nestAuthFetch(...args),
}));

import { fetchCandles } from "./useMarketCandles";

describe("fetchCandles routing", () => {
  beforeEach(() => {
    nestAuthFetch.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  const bar = { time: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 };

  it("hits the shared mt5-accounts rates endpoint for a Rithmic (futures) account", async () => {
    nestAuthFetch.mockResolvedValueOnce([bar]);
    const rithmicAccountId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

    const out = await fetchCandles(rithmicAccountId, "MNQ", "5m", 300);

    expect(nestAuthFetch).toHaveBeenCalledTimes(1);
    const url = nestAuthFetch.mock.calls[0][0] as string;
    expect(url).toContain(`/api/mt5-accounts/${rithmicAccountId}/rates/MNQ`);
    // "5m" is mapped to MT5-style "M5" (the backend understands both).
    expect(url).toContain("timeframe=M5");
    expect(url).toContain("count=300");
    expect(out).toEqual([
      { time: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 },
    ]);
  });

  it("uses the identical endpoint shape for an MT5 account", async () => {
    nestAuthFetch.mockResolvedValueOnce([bar]);
    const mt5AccountId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

    await fetchCandles(mt5AccountId, "EURUSD", "1h", 300);

    const url = nestAuthFetch.mock.calls[0][0] as string;
    expect(url).toContain(`/api/mt5-accounts/${mt5AccountId}/rates/EURUSD`);
    expect(url).toContain("timeframe=H1");
  });

  it("falls back to smaller counts when the first request returns empty", async () => {
    // MT5 (and the Rithmic bridge) return [] when asked for more bars than
    // exist on a timeframe; fetchCandles retries with smaller windows.
    nestAuthFetch.mockResolvedValueOnce([]).mockResolvedValueOnce([bar]);

    const out = await fetchCandles("acc", "MNQ", "5m", 20000);

    expect(nestAuthFetch).toHaveBeenCalledTimes(2);
    expect(nestAuthFetch.mock.calls[0][0]).toContain("count=20000");
    expect(nestAuthFetch.mock.calls[1][0]).toContain("count=10000");
    expect(out).toHaveLength(1);
  });
});
