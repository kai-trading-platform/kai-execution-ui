// Terminal mode + order-sizing strategy (spec §4.2 — "dos terminales").
//
// A single terminal shell serves two experiences whose behaviour is driven by
// the selected account's `provider`:
//   - CFD  (MT5)     → units are LOTES, fractional, step 0.01, naive sizing.
//   - Futuros (Rithmic/Apex) → units are CONTRATOS, integer, step 1, tick-value
//     based sizing + Apex `maxContracts` cap.
//
// IMPORTANT: the CFD strategy must reproduce the terminal's CURRENT behaviour
// BYTE-FOR-BYTE (same numbers, labels, stepping and sizing) so MT5 users see no
// change. All the futures-specific logic lives behind `mode === 'futures'`.

export type TerminalMode = "cfd" | "futures";

/** Provider keys as exposed by `GET /api/trading/accounts` (see types/trading). */
export type TerminalProvider = "mt5" | "rithmic" | string | null | undefined;

/** Per-symbol contract spec needed to size futures orders in contracts. */
export interface FuturesTickSpec {
  /** Minimum price increment (e.g. MNQ 0.25, MES 0.25, MGC 0.10). */
  tickSize: number;
  /** USD value of one tick for one contract (e.g. MNQ $0.50, MES $1.25). */
  tickValue: number;
}

export interface TerminalStrategy {
  mode: TerminalMode;
  /** Label shown next to the volume field: 'Lotes' | 'Contratos'. */
  unitLabel: string;
  /** Stepper increment for the +/- buttons: 0.01 (lots) | 1 (contracts). */
  volumeStep: number;
  /** Floor the volume can be decremented to: 0.01 (lots) | 1 (contract). */
  minVolume: number;
  /** Initial volume when a market of this mode is selected: '0.10' | '1'. */
  defaultVolume: string;
  /**
   * Whether BUY/SELL submit is enabled. Phase 4 keeps futures order placement
   * DISABLED (money-critical, lands in Phase 5) — the panel only previews size.
   */
  ordersEnabled: boolean;
  /** Format a numeric volume back to the canonical string for this mode. */
  formatVolume: (v: number) => string;
  /**
   * Risk-mode position size.
   *   CFD:     naive `riskUsd / slDistancePrice` rounded to 0.01 (>= 0.01).
   *   Futuros: `floor(riskUsd / (slTicks × tickValue))`, integer contracts,
   *            where `slTicks = slDistancePrice / tickSize`.
   * Returns 0 when inputs are insufficient (no SL distance / no risk / no spec).
   */
  computeSize: (
    riskUsd: number,
    slDistancePrice: number,
    spec?: FuturesTickSpec | null,
  ) => number;
}

export function modeForProvider(provider: TerminalProvider): TerminalMode {
  return provider === "rithmic" ? "futures" : "cfd";
}

// --- CFD (MT5) --------------------------------------------------------------
// Mirrors the historical inline logic in TradingTerminal.tsx exactly:
//   computedLots = Math.max(0.01, Number((riskUsd / slDist).toFixed(2)))
//   stepper      = (parseFloat(volume) ± 0.01).toFixed(2)  (min 0.01)
//   label        = "Lotes",  default = "0.10"
const CFD_STRATEGY: TerminalStrategy = {
  mode: "cfd",
  unitLabel: "Lotes",
  volumeStep: 0.01,
  minVolume: 0.01,
  defaultVolume: "0.10",
  ordersEnabled: true,
  formatVolume: (v) => v.toFixed(2),
  computeSize: (riskUsd, slDistancePrice) => {
    if (!(slDistancePrice > 0) || !(riskUsd > 0)) return 0;
    return Math.max(0.01, Number((riskUsd / slDistancePrice).toFixed(2)));
  },
};

// --- Futuros (Rithmic/Apex) -------------------------------------------------
const FUTURES_STRATEGY: TerminalStrategy = {
  mode: "futures",
  unitLabel: "Contratos",
  volumeStep: 1,
  minVolume: 1,
  defaultVolume: "1",
  // Base default OFF. The effective enablement is derived per-account from the
  // DTO capability via `resolveOrdersEnabled` (gated by the backend
  // RITHMIC_TERMINAL_ORDERS_ENABLED flag), so this stays false as the safe floor.
  ordersEnabled: false,
  formatVolume: (v) => String(Math.max(0, Math.round(v))),
  computeSize: (riskUsd, slDistancePrice, spec) => {
    if (!spec) return 0;
    const { tickSize, tickValue } = spec;
    if (!(slDistancePrice > 0) || !(riskUsd > 0)) return 0;
    if (!(tickSize > 0) || !(tickValue > 0)) return 0;
    const slDistanceInTicks = slDistancePrice / tickSize;
    if (!(slDistanceInTicks > 0)) return 0;
    const riskPerContract = slDistanceInTicks * tickValue;
    if (!(riskPerContract > 0)) return 0;
    return Math.floor(riskUsd / riskPerContract);
  },
};

export function strategyForMode(mode: TerminalMode): TerminalStrategy {
  return mode === "futures" ? FUTURES_STRATEGY : CFD_STRATEGY;
}

/** Minimal shape of the account capabilities the terminal reads from the DTO. */
export interface OrderCapabilities {
  placeMarketOrder?: boolean;
}

/**
 * Effective BUY/SELL enablement for the order ticket.
 *   - CFD (MT5): keeps the strategy's own flag (historically always true).
 *   - Futuros (Rithmic): gated by the backend capability `placeMarketOrder`,
 *     which itself reflects the `RITHMIC_TERMINAL_ORDERS_ENABLED` flag (default
 *     false) AND account connectivity. So futures orders auto-enable ONLY when
 *     the backend flag is on and the capability is true; otherwise the ticket
 *     stays preview-only ("Órdenes de futuros: próximamente").
 */
export function resolveOrdersEnabled(
  strategy: TerminalStrategy,
  capabilities?: OrderCapabilities | null,
): boolean {
  if (strategy.mode === "futures") {
    return Boolean(capabilities?.placeMarketOrder);
  }
  return strategy.ordersEnabled;
}

export function strategyForProvider(provider: TerminalProvider): TerminalStrategy {
  return strategyForMode(modeForProvider(provider));
}

/**
 * Clamp a contract count to a known Apex `maxContracts` cap. Returns the size
 * unchanged when no cap is known (`null`/`undefined`/non-positive).
 */
export function clampToMaxContracts(
  size: number,
  maxContracts: number | null | undefined,
): number {
  if (maxContracts == null || !(maxContracts > 0)) return size;
  return Math.min(size, maxContracts);
}

/**
 * Estimated USD risk for an integer futures position of `contracts` given an SL
 * price distance and the symbol tick spec. Used for the sizing preview readout.
 * Returns 0 when inputs are insufficient.
 */
export function estimateFuturesRisk(
  contracts: number,
  slDistancePrice: number,
  spec?: FuturesTickSpec | null,
): number {
  if (!spec) return 0;
  const { tickSize, tickValue } = spec;
  if (!(contracts > 0) || !(slDistancePrice > 0)) return 0;
  if (!(tickSize > 0) || !(tickValue > 0)) return 0;
  return (slDistancePrice / tickSize) * tickValue * contracts;
}
