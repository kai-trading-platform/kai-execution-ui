/**
 * Helpers to turn the broker's raw symbol names (Exness uses an `m` suffix,
 * e.g. `BTCUSDm`, `EURUSDm`, `XAUUSDm`, `USTEC_x100m`) into clean display
 * labels ("BTC/USD", "EUR/USD", "XAU/USD", "USTEC") and to rank the most
 * liquid / popular instruments first so the watchlist isn't an alphabetical
 * wall of obscure tokens.
 */

const QUOTES = [
  "USDT",
  "USDC",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "AUD",
  "CAD",
  "NZD",
  "BTC",
  "ETH",
];

/** Preferred order of instruments (by raw broker name). Lower index = higher. */
const PREFERRED: string[] = [
  // Crypto majors
  "BTCUSDm", "ETHUSDm", "SOLUSDm", "XRPUSDm", "BNBUSDm", "ADAUSDm",
  "DOGEUSDm", "AVAXUSDm", "LTCUSDm", "DOTUSDm", "LINKUSDm", "MATICUSDm",
  "BTCUSDTm", "ETHUSDTm",
  // Metals
  "XAUUSDm", "XAGUSDm",
  // FX majors
  "EURUSDm", "GBPUSDm", "USDJPYm", "USDCHFm", "AUDUSDm", "USDCADm",
  "NZDUSDm", "EURGBPm", "EURJPYm", "GBPJPYm",
  // Indices
  "USTECm", "US500m", "US30m", "USTEC_x100m", "US500_x100m", "US30_x10m",
];

const PREFERRED_INDEX = new Map(PREFERRED.map((s, i) => [s, i]));

const CATEGORY_RANK: Record<string, number> = {
  Crypto: 0,
  Commodities: 1,
  Metals: 1,
  Forex: 2,
  Indices: 3,
  Other: 4,
};

export function formatSymbolDisplay(raw: string): string {
  let s = raw;
  // Drop the broker's lowercase suffix letters (Exness "m", "c", etc.).
  s = s.replace(/[a-z]+$/, "");
  // Index style: USTEC_x100 -> USTEC
  s = s.replace(/_x\d+$/i, "");
  // FX / crypto pair BASE+QUOTE -> BASE/QUOTE
  for (const q of QUOTES) {
    if (s.length > q.length && s.endsWith(q)) {
      const base = s.slice(0, -q.length);
      if (base.length >= 2) return `${base}/${q}`;
    }
  }
  return s;
}

/** Sort key: preferred first (in list order), then by category, then name. */
export function symbolSortKey(
  name: string,
  category: string,
): [number, number, string] {
  const pref = PREFERRED_INDEX.has(name)
    ? PREFERRED_INDEX.get(name)!
    : Number.MAX_SAFE_INTEGER;
  const cat = CATEGORY_RANK[category] ?? 5;
  return [pref, cat, name];
}

const CURRENCY_GLYPH: Record<string, string> = {
  USD: "$", USDT: "$", USDC: "$", EUR: "€", GBP: "£", JPY: "¥",
  CHF: "₣", AUD: "A", CAD: "C", NZD: "N", CNH: "¥", MXN: "$",
};

const ASSET_GLYPH: Record<string, string> = {
  BTC: "₿", ETH: "Ξ", XAU: "Au", XAG: "Ag", SOL: "S", XRP: "X",
  BNB: "B", ADA: "A", DOGE: "Ð", LTC: "Ł", DOT: "•", LINK: "⬡", MATIC: "M",
};

/** A small round badge (glyph + colors) for a symbol, like the target design. */
export function symbolIcon(raw: string): { glyph: string; bg: string; fg: string } {
  const d = formatSymbolDisplay(raw);
  const [base, quote] = d.split("/");
  // Metals → gold/silver badge
  if (base === "XAU") return { glyph: "Au", bg: "#d4af37", fg: "#1a1400" };
  if (base === "XAG") return { glyph: "Ag", bg: "#c0c4cc", fg: "#1a1a1a" };
  // Crypto → asset glyph on a tinted badge
  if (ASSET_GLYPH[base] && (!quote || quote === "USD" || quote === "USDT")) {
    if (base === "BTC") return { glyph: "₿", bg: "#f7931a", fg: "#1a1400" };
    if (base === "ETH") return { glyph: "Ξ", bg: "#6481e7", fg: "#fff" };
    return { glyph: ASSET_GLYPH[base], bg: "#2b3650", fg: "#dfe4ec" };
  }
  // FX pair → two currency glyphs
  if (quote && CURRENCY_GLYPH[base] !== undefined) {
    return { glyph: `${CURRENCY_GLYPH[base] ?? base[0]}${CURRENCY_GLYPH[quote] ?? ""}`, bg: "#3a4252", fg: "#dfe4ec" };
  }
  // Fallback (indices, stocks) → first two letters
  return { glyph: base.slice(0, 2), bg: "#3a4252", fg: "#dfe4ec" };
}

export function compareSymbols(
  a: { name: string; category: string },
  b: { name: string; category: string },
): number {
  const [ap, ac, an] = symbolSortKey(a.name, a.category);
  const [bp, bc, bn] = symbolSortKey(b.name, b.category);
  if (ap !== bp) return ap - bp;
  if (ac !== bc) return ac - bc;
  return an.localeCompare(bn);
}
