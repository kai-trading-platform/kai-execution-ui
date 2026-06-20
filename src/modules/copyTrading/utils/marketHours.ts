type MarketType = "crypto" | "forex" | "futures" | "stocks";

export interface MarketOpenStatus {
  isOpen: boolean;
  marketType: MarketType;
  reason?: string;
}

function resolveMarketType(symbolValue?: string | null): MarketType {
  const symbol = String(symbolValue || "").toUpperCase().trim();
  if (!symbol) return "stocks";
  const compact = symbol.replace(/[^A-Z0-9]/g, "");

  const cryptoIds = ["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "AVAX", "LINK", "DOT"];
  if (
    cryptoIds.some(
      (id) =>
        symbol.startsWith(id) ||
        symbol.includes(`${id}/`) ||
        symbol.includes(`/${id}`),
    )
  ) {
    return "crypto";
  }

  if (symbol.includes("/")) return "forex";
  if (symbol.includes("=F")) return "futures";

  const currencyCodes = [
    "USD",
    "EUR",
    "GBP",
    "JPY",
    "CHF",
    "CAD",
    "AUD",
    "NZD",
    "SEK",
    "NOK",
    "MXN",
    "SGD",
    "HKD",
    "ZAR",
  ];
  if (
    (compact.length >= 6 &&
      currencyCodes.includes(compact.slice(0, 3)) &&
      currencyCodes.includes(compact.slice(3, 6))) ||
    compact.startsWith("XAUUSD") ||
    compact.startsWith("XAGUSD")
  ) {
    return "forex";
  }

  const futuresLikeIndexTickers = [
    "NDX", "SPX", "DJI", "VIX", "RUT",
    "NAS100", "US30", "SP500", "GER30", "GER40", "UK100", "JPN225",
    "USTEC", "NAS", "US100",
    "XAU", "XAG", "XPD", "XPT",
    "ES", "NQ", "YM", "RTY",
  ];
  if (futuresLikeIndexTickers.some((ticker) => symbol.includes(ticker))) {
    return "futures";
  }

  return "stocks";
}

function getNyDateParts(now: Date): { day: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value || "Mon";
  const hour = Number(parts.find((p) => p.type === "hour")?.value || "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value || "0");

  const day = (() => {
    switch (weekday) {
      case "Sun":
        return 0;
      case "Mon":
        return 1;
      case "Tue":
        return 2;
      case "Wed":
        return 3;
      case "Thu":
        return 4;
      case "Fri":
        return 5;
      case "Sat":
        return 6;
      default:
        return 1;
    }
  })();

  return { day, hour, minute };
}

export function getMarketOpenStatus(symbolValue?: string | null, now = new Date()): MarketOpenStatus {
  const marketType = resolveMarketType(symbolValue);
  if (marketType === "crypto") {
    return { isOpen: true, marketType };
  }

  const { day, hour, minute } = getNyDateParts(now);

  if (day === 6) {
    return {
      isOpen: false,
      marketType,
      reason: "Fin de semana: el mercado está cerrado.",
    };
  }

  if (marketType === "forex" || marketType === "futures") {
    if (day === 5 && hour >= 17) {
      return {
        isOpen: false,
        marketType,
        reason: "El mercado cerró el viernes a las 5:00 PM (NY).",
      };
    }

    if (day === 0 && hour < 18) {
      return {
        isOpen: false,
        marketType,
        reason: "El mercado abre el domingo a las 6:00 PM (NY).",
      };
    }

    if (day >= 1 && day <= 4 && hour === 17) {
      return {
        isOpen: false,
        marketType,
        reason: "Pausa diaria del mercado entre 5:00 PM y 6:00 PM (NY).",
      };
    }

    return { isOpen: true, marketType };
  }

  if (day === 0) {
    return {
      isOpen: false,
      marketType,
      reason: "Domingo: el mercado de acciones está cerrado.",
    };
  }

  if (day === 5 && (hour > 16 || (hour === 16 && minute > 0))) {
    return {
      isOpen: false,
      marketType,
      reason: "El mercado de acciones cerró a las 4:00 PM (NY).",
    };
  }

  const beforeOpen = hour < 9 || (hour === 9 && minute < 30);
  const afterClose = hour > 16 || (hour === 16 && minute > 0);
  if (beforeOpen || afterClose) {
    return {
      isOpen: false,
      marketType,
      reason: "Horario de acciones: 9:30 AM a 4:00 PM (NY).",
    };
  }

  return { isOpen: true, marketType };
}
