import { describe, expect, it } from "vitest";

import {
  clampToMaxContracts,
  estimateFuturesRisk,
  modeForProvider,
  strategyForMode,
  strategyForProvider,
  type FuturesTickSpec,
} from "./terminalMode";

describe("modeForProvider", () => {
  it("maps rithmic to futures and everything else to cfd", () => {
    expect(modeForProvider("rithmic")).toBe("futures");
    expect(modeForProvider("mt5")).toBe("cfd");
    expect(modeForProvider(null)).toBe("cfd");
    expect(modeForProvider(undefined)).toBe("cfd");
    expect(modeForProvider("unknown")).toBe("cfd");
  });
});

describe("CFD strategy (MT5) — must stay byte-identical to legacy behaviour", () => {
  const s = strategyForMode("cfd");

  it("exposes the legacy label / step / default", () => {
    expect(s.mode).toBe("cfd");
    expect(s.unitLabel).toBe("Lotes");
    expect(s.volumeStep).toBe(0.01);
    expect(s.minVolume).toBe(0.01);
    expect(s.defaultVolume).toBe("0.10");
    expect(s.ordersEnabled).toBe(true);
  });

  it("formats volume with 2 decimals (0.1 -> '0.10')", () => {
    expect(s.formatVolume(0.1)).toBe("0.10");
    expect(s.formatVolume(1)).toBe("1.00");
    expect(s.formatVolume(0.55)).toBe("0.55");
  });

  it("computeSize reproduces `max(0.01, (riskUsd / slDist).toFixed(2))`", () => {
    // capital 10000 @ 1% => riskUsd 100; slDist price 5 => 100/5 = 20 lots
    expect(s.computeSize(100, 5)).toBe(20);
    // 100 / 250 = 0.4
    expect(s.computeSize(100, 250)).toBe(0.4);
    // tiny risk floors at 0.01
    expect(s.computeSize(1, 1000)).toBe(0.01);
    // rounding to 2 decimals: 100 / 3 = 33.333.. -> 33.33
    expect(s.computeSize(100, 3)).toBe(33.33);
  });

  it("computeSize returns 0 for missing inputs", () => {
    expect(s.computeSize(0, 5)).toBe(0);
    expect(s.computeSize(100, 0)).toBe(0);
    expect(s.computeSize(-100, 5)).toBe(0);
  });

  it("ignores any tick spec passed in (CFD is price-distance based)", () => {
    const spec: FuturesTickSpec = { tickSize: 0.25, tickValue: 0.5 };
    expect(s.computeSize(100, 5, spec)).toBe(20);
  });
});

describe("Futures strategy (Rithmic/Apex)", () => {
  const s = strategyForProvider("rithmic");
  // MNQ micro NASDAQ: tick 0.25, tick value $0.50 => $2 per point.
  const mnq: FuturesTickSpec = { tickSize: 0.25, tickValue: 0.5 };

  it("exposes contract label / integer step / disabled orders", () => {
    expect(s.mode).toBe("futures");
    expect(s.unitLabel).toBe("Contratos");
    expect(s.volumeStep).toBe(1);
    expect(s.minVolume).toBe(1);
    expect(s.defaultVolume).toBe("1");
    expect(s.ordersEnabled).toBe(false); // Phase 4: preview only
  });

  it("formats volume as an integer string", () => {
    expect(s.formatVolume(1)).toBe("1");
    expect(s.formatVolume(3.4)).toBe("3");
    expect(s.formatVolume(2.6)).toBe("3");
    expect(s.formatVolume(0)).toBe("0");
  });

  it("sizes contracts = floor(riskUsd / (slTicks × tickValue))", () => {
    // SL distance 20 points = 80 ticks; risk/contract = 80 * 0.5 = $40.
    // riskUsd 100 => floor(100/40) = 2 contracts.
    expect(s.computeSize(100, 20, mnq)).toBe(2);
    // riskUsd 200 => floor(200/40) = 5
    expect(s.computeSize(200, 20, mnq)).toBe(5);
    // risk too small for even one contract => 0
    expect(s.computeSize(10, 20, mnq)).toBe(0);
  });

  it("returns 0 without a tick spec or with an invalid spec", () => {
    expect(s.computeSize(100, 20)).toBe(0);
    expect(s.computeSize(100, 20, null)).toBe(0);
    expect(s.computeSize(100, 20, { tickSize: 0, tickValue: 0.5 })).toBe(0);
    expect(s.computeSize(100, 20, { tickSize: 0.25, tickValue: 0 })).toBe(0);
    expect(s.computeSize(100, 0, mnq)).toBe(0);
    expect(s.computeSize(0, 20, mnq)).toBe(0);
  });
});

describe("clampToMaxContracts (Apex cap)", () => {
  it("clamps to the cap when known", () => {
    expect(clampToMaxContracts(5, 1)).toBe(1); // Apex = 1
    expect(clampToMaxContracts(5, 3)).toBe(3);
    expect(clampToMaxContracts(2, 3)).toBe(2);
  });

  it("passes through when no cap is known", () => {
    expect(clampToMaxContracts(5, null)).toBe(5);
    expect(clampToMaxContracts(5, undefined)).toBe(5);
    expect(clampToMaxContracts(5, 0)).toBe(5);
  });
});

describe("estimateFuturesRisk", () => {
  const mnq: FuturesTickSpec = { tickSize: 0.25, tickValue: 0.5 };

  it("computes USD risk for an integer contract count", () => {
    // 2 contracts, SL 20 points = 80 ticks * 0.5 = $40/contract => $80
    expect(estimateFuturesRisk(2, 20, mnq)).toBe(80);
    expect(estimateFuturesRisk(1, 20, mnq)).toBe(40);
  });

  it("returns 0 for insufficient inputs", () => {
    expect(estimateFuturesRisk(0, 20, mnq)).toBe(0);
    expect(estimateFuturesRisk(2, 0, mnq)).toBe(0);
    expect(estimateFuturesRisk(2, 20, null)).toBe(0);
  });
});
