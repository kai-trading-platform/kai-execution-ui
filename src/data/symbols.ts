/* eslint-disable @typescript-eslint/no-explicit-any */
export const MARKET_SYMBOLS = [
    {
        category: "Futuros / Índices",
        symbols: [
            { value: "NQ=F", label: "NASDAQ E-mini (NQ)" },
            { value: "MNQ=F", label: "NASDAQ Micro (MNQ)" },
            { value: "^NDX", label: "NASDAQ Index (NDX)" },
            { value: "ES=F", label: "S&P 500 E-mini (ES)" },
            { value: "MES=F", label: "Micro S&P 500 Futures (MES)" },
            { value: "YM=F", label: "Dow Jones 30 (YM)" },
            { value: "RTY=F", label: "Russell 2000 (RTY)" },
            { value: "GC=F", label: "Gold Futures (GC)" },
            { value: "CL=F", label: "Crude Oil WTI (CL)" },
            { value: "SI=F", label: "Silver Futures (SI)" },
            { value: "NG=F", label: "Natural Gas (NG)" },
        ]
    },
    {
        category: "Forex / Commodities",
        symbols: [
            { value: "EUR/USD", label: "Euro / Dólar (EUR/USD)" },
            { value: "GBP/USD", label: "Libra / Dólar (GBP/USD)" },
            { value: "USD/JPY", label: "Dólar / Yen (USD/JPY)" },
        ]
    },
    {
        category: "Criptomonedas",
        symbols: [
            { value: "BTC/USD", label: "Bitcoin (BTC/USD)" },
            { value: "ETH/USD", label: "Ethereum (ETH/USD)" },
            { value: "SOL/USD", label: "Solana (SOL/USD)" },
            { value: "XRP/USD", label: "Ripple (XRP/USD)" },
            { value: "ADA/USD", label: "Cardano (ADA/USD)" },
            { value: "DOGE/USD", label: "Dogecoin (DOGE/USD)" },
            { value: "AVAX/USD", label: "Avalanche (AVAX/USD)" },
            { value: "LINK/USD", label: "Chainlink (LINK/USD)" },
            { value: "DOT/USD", label: "Polkadot (DOT/USD)" },
        ]
    },
    {
        category: "Acciones",
        symbols: [
            { value: "AAPL", label: "Apple (AAPL)" },
            { value: "MSFT", label: "Microsoft (MSFT)" },
            { value: "GOOGL", label: "Google (GOOGL)" },
            { value: "AMZN", label: "Amazon (AMZN)" },
            { value: "META", label: "Meta/Facebook (META)" },
            { value: "NVDA", label: "NVIDIA (NVDA)" },
            { value: "TSLA", label: "Tesla (TSLA)" },
            { value: "AMD", label: "AMD (AMD)" },
            { value: "NFLX", label: "Netflix (NFLX)" },
            { value: "INTC", label: "Intel (INTC)" },
            { value: "DIS", label: "Disney (DIS)" },
            { value: "PYPL", label: "PayPal (PYPL)" },
            { value: "UBER", label: "Uber (UBER)" },
            { value: "COIN", label: "Coinbase (COIN)" },
            { value: "BA", label: "Boeing (BA)" },
            { value: "JPM", label: "JP Morgan (JPM)" },
            { value: "V", label: "Visa (V)" },
            { value: "MA", label: "Mastercard (MA)" },
        ]
    }
];

export function normalizeMarketOption(market: unknown): { value: string; label: string; symbol: string } {
    if (typeof market === 'string') {
        const trimmed = market.trim();
        // If the string itself is a serialized JSON/Python dict, parse it
        if (trimmed.startsWith('{') && (trimmed.includes("'name'") || trimmed.includes('"name"'))) {
            try {
                const cleaned = trimmed.replace(/'/g, '"');
                const parsed = JSON.parse(cleaned);
                if (parsed && typeof parsed === 'object') {
                    return normalizeMarketOption(parsed);
                }
            } catch {
                // Fallback: regex extraction
                const nameMatch = trimmed.match(/['"]name['"]:\s*['"]([^'"]+)['"]/);
                const descMatch = trimmed.match(/['"](?:description|descr|displayName)['"]:\s*['"]([^'"]+)['"]/);
                if (nameMatch) {
                    const sym = nameMatch[1];
                    const desc = descMatch ? descMatch[1] : '';
                    return {
                        value: sym,
                        symbol: sym,
                        label: desc ? `${sym} — ${desc}` : sym
                    };
                }
            }
        }
        return { value: market, label: market, symbol: market };
    }

    if (market && typeof market === 'object') {
        const m = market as any;
        let symbol = String(m.name || m.symbol || m.path || m.id || '').trim();
        let description = String(m.description || m.descr || m.displayName || '').trim();

        // If the symbol field itself contains stringified object, parse it
        if (symbol.startsWith('{') && (symbol.includes("'name'") || symbol.includes('"name"'))) {
            try {
                const cleaned = symbol.replace(/'/g, '"');
                const parsed = JSON.parse(cleaned);
                if (parsed && typeof parsed === 'object') {
                    const inner = normalizeMarketOption(parsed);
                    if (inner.value) {
                        symbol = inner.value;
                        if (!description && inner.label !== inner.value) {
                            return inner;
                        }
                    }
                }
            } catch {
                // Fallback: regex extraction
                const nameMatch = symbol.match(/['"]name['"]:\s*['"]([^'"]+)['"]/);
                const descMatch = symbol.match(/['"](?:description|descr|displayName)['"]:\s*['"]([^'"]+)['"]/);
                if (nameMatch) {
                    symbol = nameMatch[1];
                    if (!description && descMatch) {
                        description = descMatch[1];
                    }
                }
            }
        }

        return {
            value: symbol,
            symbol,
            label: description ? `${symbol} — ${description}` : symbol
        };
    }

    return { value: '', label: '', symbol: '' };
}

export function getMarketSymbolLabel(value: string): string | null {
    for (const category of MARKET_SYMBOLS) {
        const found = category.symbols.find((s) => s.value === value);
        if (found) return found.label;
    }
    return null;
}

export function getMarketSymbolDisplay(value: string): string {
    const option = normalizeMarketOption(value);
    const resolved = option.value || value;
    return getMarketSymbolLabel(resolved) || resolved;
}

export function getMarketSymbol(market: Record<string, unknown> | string): string {
    const option = normalizeMarketOption(market);
    return option.value;
}

export function getMarketLabel(market: Record<string, unknown> | string): string {
    const option = normalizeMarketOption(market);
    return option.label;
}

