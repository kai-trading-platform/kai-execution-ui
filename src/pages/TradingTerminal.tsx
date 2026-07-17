import { useSearchParams } from "react-router-dom";
import { useEffect, useMemo, useRef, useState, useCallback, Fragment } from "react";
import { Bell, Wifi, WifiOff, Search, Plus, ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Eye, EyeOff, Loader2, X, Menu, Settings } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useConnectionLatency } from "@/hooks/useConnectionLatency";
import { usePriceAlerts } from "@/hooks/usePriceAlerts";
import { AlertsDialog } from "@/components/AlertsDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { useTerminalSettings } from "@/hooks/useTerminalSettings";
import { cn } from "@/lib/utils";
import { useTradingAccounts } from "@/hooks/useTradingAccounts";
import { useTradingPositions } from "@/hooks/useTradingPositions";
import { useTradingHistory } from "@/hooks/useTradingHistory";
import { useTradingOrders } from "@/hooks/useTradingOrders";
import { useAccountSymbols } from "@/hooks/useAccountSymbols";
import { useMarketSocket } from "@/contexts/MarketSocketContext";
import { usePlaceTradingOrder } from "@/hooks/usePlaceTradingOrder";
import { useCloseTradingPosition } from "@/hooks/useCloseTradingPosition";
import { useFlattenAllPositions } from "@/hooks/useFlattenAllPositions";
import { useCancelAllOrders } from "@/hooks/useCancelAllOrders";
import { useReversePosition } from "@/hooks/useReversePosition";
import { useUpdateTradingPositionStops } from "@/hooks/useUpdateTradingPositionStops";
import { KaiChart } from "@/components/KaiChart";
import { KaiChartPro } from "@/components/KaiChartPro";
import { setKaiPositionCloseHandler } from "@/lib/chartPro/kaiPositionBox";
import { FavTimeframeBar } from "@/components/FavTimeframeBar";
import { ErrorBoundary } from "@/components/ErrorBoundary";

// Migración de chart a @klinecharts/pro (suite ampliada de drawing tools +
// indicadores). Encendido por defecto; para volver al chart anterior sin
// tocar código: VITE_CHART_PRO=false.
const USE_CHART_PRO = import.meta.env.VITE_CHART_PRO !== "false";
import type { CopyTradingPosition } from "@/modules/copyTrading/types";
import type { TradingHistoryItem, TradingOrder } from "@/types/trading";
import { toUiPosition } from "@/lib/positionMapping";
import { resolveOrderEntryPrice } from "@/lib/orderEntryPrice";
import { formatSymbolDisplay, compareSymbols, symbolIcon } from "@/lib/symbolDisplay";
import { useMarketCandles } from "@/modules/copyTrading/hooks/useMarketCandles";
import { toast } from "@/components/ui/sonner";
import { useConfirm } from "@/components/ConfirmDialogProvider";
import { REAL_CONFIRMATION_TEXT } from "@/constants/tradingExecution";
import {
  modeForProvider,
  strategyForMode,
  resolveOrdersEnabled,
  clampToMaxContracts,
  estimateFuturesRisk,
  accountsForRoute,
  type TerminalMode,
  type TerminalStrategy,
  type FuturesTickSpec,
} from "@/lib/terminalMode";

/** API contract: the execution backend only accepts market orders today. */
type TradingOrderSide = "buy" | "sell";

// Max symbols to stream live in the watchlist at once (see effect below for why).
const WATCHLIST_LIVE_CAP = 20;

// Default instrument when nothing is selected/persisted for the account: pick
// MNQ when the catalog has it (sim/futures accounts expose the CME roots, and
// the alphabetical first would be ES), otherwise fall back to the
// liquidity-sorted first symbol as before. Matched by raw name AND display so
// both plain roots ("MNQ") and broker variants that render as "MNQ" qualify.
const PREFERRED_DEFAULT_SYMBOL = "MNQ";

// Stable empty fallback so query destructures don't mint a NEW [] on every
// render while data is loading (unstable identities cascade into effects and
// memos downstream — see the "Maximum update depth exceeded" fix in KaiChart).
const EMPTY_LIST: never[] = [];

type BottomTab = "CUENTAS" | "POSICIONES" | "ORDENES";
type OrderType = "MERCADO" | "LIMITE" | "STOP";
type OrderMode = "regular" | "oneClick" | "risk";
type Panel = "watchlist" | "trade" | "bottom";

/**
 * Phase 6 — route-scoped terminal entries. `undefined` (the universal
 * `/trading/terminal` entry) lists every account and infers the mode from the
 * selected account's provider, exactly as before (backward-compatible with
 * existing SSO deep-links). `"futures"` / `"cfd"` (the `/trading/futuros` and
 * `/trading/cfd` deep-links) filter the account selector to that provider and
 * pin the terminal mode to it, so the route's promised experience renders
 * even while accounts are loading or none match yet.
 */
interface TradingTerminalPageProps {
  forcedMode?: TerminalMode;
}

export default function TradingTerminalPage({ forcedMode }: TradingTerminalPageProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const accountId = searchParams.get("account");
  const { data: accounts = EMPTY_LIST, isLoading: accountsLoading } = useTradingAccounts();

  // Route-scoped view of the accounts list: unfiltered for the universal
  // /trading/terminal entry, narrowed to the route's provider for
  // /trading/futuros and /trading/cfd (spec §6 — "selector FILTERED to that
  // route's provider").
  const routeAccounts = useMemo(
    () => accountsForRoute(accounts, forcedMode),
    [accounts, forcedMode],
  );

  const resolvedAccount = useMemo(() => {
    if (accountId) {
      const fromList = routeAccounts.find((a: { providerAccountId?: string; id: string }) => a.providerAccountId === accountId);
      if (fromList) return fromList;
    }
    // ?account= is missing, or points at an account that doesn't match this
    // route's provider (e.g. an MT5 id opened on /trading/futuros): fall back
    // to the first connected account IN THIS ROUTE'S SCOPE, same as the
    // pre-Phase-6 fallback did over the full list. Least-surprising choice
    // over an empty state — the URL effect below reflects it back so the
    // account param and header selector stay consistent.
    const firstConnected = routeAccounts.find((a: { status?: string }) => a.status === "connected");
    return firstConnected ?? routeAccounts[0] ?? null;
  }, [accountId, routeAccounts]);

  // When ?account= is missing/empty (or doesn't match any account) we default
  // to the first connected account. Reflect that choice back into the URL so
  // the param is never silently empty: per-account state keyed by the URL param
  // (open tabs, etc.) works, refresh/share keeps the same account, and the
  // header selector shows a real account instead of "—".
  const resolvedProviderId = (resolvedAccount as { providerAccountId?: string | null } | null)?.providerAccountId ?? null;
  useEffect(() => {
    if (!resolvedProviderId || accountId === resolvedProviderId) return;
    const matchesParam = Boolean(
      accountId && routeAccounts.some((a: { providerAccountId?: string | null }) => a.providerAccountId === accountId),
    );
    if (matchesParam) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("account", resolvedProviderId);
        return next;
      },
      { replace: true },
    );
  }, [accountId, resolvedProviderId, routeAccounts, setSearchParams]);

  const dbAccountId = (resolvedAccount as { id?: string } | null)?.id ?? null;
  const { data: positions = EMPTY_LIST, isLoading: positionsLoading } = useTradingPositions(dbAccountId);
  // Trades CERRADOS de la cuenta → se dibujan como cajas LONG/SHORT en el chart y
  // alimentan la sección "Ejecutadas" de la pestaña ÓRDENES.
  const { data: historyTrades = EMPTY_LIST } = useTradingHistory(dbAccountId);
  // Órdenes PENDIENTES (working orders) → sección "Pendientes" de ÓRDENES.
  const { data: orders = EMPTY_LIST } = useTradingOrders(dbAccountId);
  const { symbols, groupedSymbols, loading: symbolsLoading, loadedForAccountId } = useAccountSymbols(dbAccountId);

  // Terminal mode is derived from the selected account's provider (spec §4.2):
  // MT5 → CFD (lotes), Rithmic → Futuros (contratos). The strategy drives the
  // order ticket's units, stepping, default volume, sizing and whether orders
  // can be placed. CFD reproduces the historical behaviour byte-for-byte.
  // On a route-scoped entry (forcedMode set), the route itself pins the mode
  // — this keeps /trading/futuros showing the futures shell even with no
  // resolved account yet (empty state), rather than briefly rendering CFD.
  const provider = (resolvedAccount as { provider?: string | null } | null)?.provider ?? null;
  const terminalMode: TerminalMode = forcedMode ?? modeForProvider(provider);
  // Order placement enablement is derived per-account from the DTO capability
  // (`placeMarketOrder`), which reflects the backend RITHMIC_TERMINAL_ORDERS_ENABLED
  // flag (default false) + connectivity. CFD stays byte-identical (always on);
  // futures BUY/SELL auto-enable ONLY when the backend flag is on and capability
  // is true — otherwise the ticket is preview-only ("Órdenes de futuros: próximamente").
  const capabilities =
    (resolvedAccount as { capabilities?: { placeMarketOrder?: boolean } } | null)?.capabilities ?? null;
  const strategy = useMemo(() => {
    const base = strategyForMode(terminalMode);
    const ordersEnabled = resolveOrdersEnabled(base, capabilities);
    return ordersEnabled === base.ordersEnabled ? base : { ...base, ordersEnabled };
  }, [terminalMode, capabilities]);
  // Apex `autotrading:maxContracts:<id>` cap, now stamped on each account by
  // execution-api's listAccounts (query.service.ts#getMaxContractsMap). Read
  // defensively like the other resolvedAccount fields above; `null` when the
  // account has no cap configured.
  const maxContracts = (resolvedAccount as { maxContracts?: number | null } | null)?.maxContracts ?? null;

  const [selectedSymbol, setSelectedSymbol] = useState<string>("");
  // Doble clic en un trade de ÓRDENES → llevar el chart a ese trade (entrada y
  // salida, para encuadrar la caja LONG/SHORT completa).
  const [focusTrade, setFocusTrade] = useState<
    { symbol: string; from: number; to: number; nonce: number } | null
  >(null);
  const focusNonceRef = useRef(0);
  const handleFocusTrade = useCallback(
    (t: TradingHistoryItem) => {
      const from = t.openedAt ? Date.parse(t.openedAt) : NaN;
      const toRaw = t.closedAt ? Date.parse(t.closedAt) : NaN;
      const anchor = Number.isFinite(from) ? from : toRaw;
      if (!Number.isFinite(anchor) || !t.symbol) return;
      const to = Number.isFinite(toRaw) ? toRaw : anchor;
      if (t.symbol !== selectedSymbol) setSelectedSymbol(t.symbol);
      focusNonceRef.current += 1;
      setFocusTrade({
        symbol: t.symbol,
        from: Number.isFinite(from) ? from : to,
        to,
        nonce: focusNonceRef.current,
      });
    },
    [selectedSymbol],
  );
  // Doble clic en una POSICIÓN abierta → centrar el chart en su entrada (la
  // caja se extiende entrada→ahora, así que centramos en la entrada).
  const handleFocusPosition = useCallback(
    (p: CopyTradingPosition) => {
      const from = p.openedAtIso ? Date.parse(p.openedAtIso) : NaN;
      if (!Number.isFinite(from) || !p.symbol) return;
      if (p.symbol !== selectedSymbol) setSelectedSymbol(p.symbol);
      focusNonceRef.current += 1;
      setFocusTrade({
        symbol: p.symbol,
        from,
        to: from,
        nonce: focusNonceRef.current,
      });
    },
    [selectedSymbol],
  );
  const [categoryFilter, setCategoryFilter] = useState<string>("TODO");
  const [orderType, setOrderType] = useState<OrderType>("MERCADO");
  const [orderMode, setOrderModeState] = useState<OrderMode>(() => {
    try {
      return (localStorage.getItem("kai:orderMode") as OrderMode) || "regular";
    } catch {
      return "regular";
    }
  });
  const setOrderMode = useCallback((m: OrderMode) => {
    setOrderModeState(m);
    try {
      localStorage.setItem("kai:orderMode", m);
    } catch {
      /* ignore */
    }
  }, []);
  const [volume, setVolume] = useState<string>("0.10");
  // When the terminal mode flips (account switched between MT5 ⇄ Rithmic) reset
  // the volume to that mode's default unit. For MT5 this sets "0.10" (identical
  // to the initial state → no visible change); for futures it sets "1" contract.
  useEffect(() => {
    setVolume(strategy.defaultVolume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalMode]);
  const [takeProfitEnabled, setTakeProfitEnabled] = useState<boolean>(false);
  const [stopLossEnabled, setStopLossEnabled] = useState<boolean>(false);
  const [takeProfitPrice, setTakeProfitPrice] = useState<string>("");
  const [stopLossPrice, setStopLossPrice] = useState<string>("");
  const [bottomTab, setBottomTab] = useState<BottomTab>("POSICIONES");
  // En móvil el panel inferior arranca CERRADO para que el chart use todo el
  // alto (si no, aplasta el chart a una franja). El tab "Posiciones" lo abre.
  const [bottomOpen, setBottomOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    // Preferencia guardada del usuario (abierto/cerrado); si no hay, el default
    // responsivo (desktop abierto, móvil cerrado).
    const saved = localStorage.getItem("kai:bottomOpen");
    if (saved === "1") return true;
    if (saved === "0") return false;
    return window.innerWidth >= 768;
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("kai:bottomOpen", bottomOpen ? "1" : "0");
    }
  }, [bottomOpen]);

  // Al abrir/cerrar el panel inferior (CUENTAS/POSICIONES/…) el área del chart
  // cambia de alto. El chart Pro (klinecharts) solo se reajusta con
  // window.resize (el fork lo escucha → widget.resize()), así que lo disparamos
  // tras el reflow para que el eje X no quede recortado bajo el panel.
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(id);
  }, [bottomOpen]);

  // Watchlist (izquierda) y panel ORDER (derecha) colapsables — persistidos en
  // localStorage con el mismo patrón que kai:bottomOpen. Defaults SOLO cuando
  // no hay valor guardado: watchlist OCULTA, panel ORDER ABIERTO.
  const [watchlistOpen, setWatchlistOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    const saved = localStorage.getItem("kai:watchlistOpen");
    if (saved === "1") return true;
    if (saved === "0") return false;
    return false;
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("kai:watchlistOpen", watchlistOpen ? "1" : "0");
    }
  }, [watchlistOpen]);
  const [orderPanelOpen, setOrderPanelOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return true;
    const saved = localStorage.getItem("kai:orderPanelOpen");
    if (saved === "1") return true;
    if (saved === "0") return false;
    return true;
  });
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("kai:orderPanelOpen", orderPanelOpen ? "1" : "0");
    }
  }, [orderPanelOpen]);
  // Igual que bottomOpen: al colapsar/expandir los paneles laterales el chart
  // cambia de ancho y klinecharts solo se reajusta con window.resize. Los
  // asides animan su width (transition 200ms), así que además del frame
  // siguiente se re-dispara al terminar la transición para el ancho final.
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    const tid = window.setTimeout(() => window.dispatchEvent(new Event("resize")), 250);
    return () => {
      cancelAnimationFrame(id);
      window.clearTimeout(tid);
    };
  }, [watchlistOpen, orderPanelOpen]);

  const [closeAllOpen, setCloseAllOpen] = useState<boolean>(false);
  const [closingBatch, setClosingBatch] = useState<boolean>(false);
  const [alertsOpen, setAlertsOpen] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [mobilePanel, setMobilePanel] = useState<Panel | null>(null);
  const { settings, setSetting } = useTerminalSettings();
  const [timeframe, setTimeframeState] = useState<string>(() => {
    try {
      return localStorage.getItem("kai:timeframe") || "1h";
    } catch {
      return "1h";
    }
  });
  const setTimeframe = useCallback((tf: string) => {
    setTimeframeState(tf);
    try {
      localStorage.setItem("kai:timeframe", tf);
    } catch {
      /* ignore */
    }
  }, []);

  // ── Open market tabs (Exness-style) ──────────────────────────────────────
  // The header shows one tab per open instrument; the active tab drives the
  // chart + trade panel. Tabs persist per account so they survive a refresh.
  const [openSymbols, setOpenSymbols] = useState<string[]>([]);
  useEffect(() => {
    if (!accountId) return;
    try {
      const raw = localStorage.getItem(`kai:tabs:${accountId}`);
      setOpenSymbols(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setOpenSymbols([]);
    }
  }, [accountId]);
  useEffect(() => {
    if (!accountId) return;
    try {
      localStorage.setItem(`kai:tabs:${accountId}`, JSON.stringify(openSymbols));
    } catch {
      /* ignore */
    }
  }, [accountId, openSymbols]);

  const openSymbol = useCallback((sym: string) => {
    setOpenSymbols((prev) => (prev.includes(sym) ? prev : [...prev, sym]));
    setSelectedSymbol(sym);
    setMobilePanel(null);
  }, []);
  const closeSymbol = useCallback((sym: string) => {
    setOpenSymbols((prev) => {
      const idx = prev.indexOf(sym);
      const next = prev.filter((s) => s !== sym);
      setSelectedSymbol((cur) => {
        if (cur !== sym) return cur;
        if (next.length === 0) return "";
        return next[Math.min(idx, next.length - 1)];
      });
      return next;
    });
  }, []);

  const { ticks: liveTicks, subscribe: socketSubscribe, unsubscribe: socketUnsubscribe, isConnected: marketConnected } = useMarketSocket();
  const placeOrder = usePlaceTradingOrder();
  const closePosition = useCloseTradingPosition();
  const updateStops = useUpdateTradingPositionStops();
  const flattenAll = useFlattenAllPositions();
  const cancelAll = useCancelAllOrders();
  const reversePos = useReversePosition();

  useEffect(() => {
    document.title = `Kai Trading Terminal${accountId ? ` - ${accountId}` : ""}`;
  }, [accountId]);

  // ── Connection quality (internet health) ────────────────────────────────
  // Pings the backend every 5s. Thresholds are lenient on purpose: a local dev
  // round-trip through the Vite proxy is routinely 100-300ms and is NOT a slow
  // connection, so only flag "weak" past 600ms and "bad" past 1.2s / failure.
  // We deliberately ignore the market socket here — it can be legitimately down
  // (e.g. weekends) without the user's internet being bad.
  const latency = useConnectionLatency("/api/health", 5000);
  const connQuality: "good" | "weak" | "bad" = useMemo(() => {
    if (latency.status === "measuring") return "good";
    if (latency.status === "error" || latency.latencyMs == null) return "bad";
    if (latency.latencyMs >= 1200) return "bad";
    if (latency.latencyMs >= 600) return "weak";
    return "good";
  }, [latency.status, latency.latencyMs]);
  // Aviso de conexión con HISTÉRESIS para no spamear: "weak" ya NO dispara toast
  // (600ms es latencia común, era ruido), y "bad" debe persistir 2 lecturas
  // seguidas (~10s) antes de avisar — así un ping transitorio no flapea el aviso.
  // Sólo un toast "bad" y, al recuperar, uno de "restablecida".
  const badStreakRef = useRef(0);
  const committedBadRef = useRef(false);
  useEffect(() => {
    if (connQuality === "bad") {
      badStreakRef.current += 1;
      if (badStreakRef.current >= 2 && !committedBadRef.current) {
        committedBadRef.current = true;
        toast.error("Sin conexión estable", {
          description: "Tu internet falla. Ten precaución: las órdenes podrían no enviarse.",
        });
      }
      return;
    }
    badStreakRef.current = 0;
    if (committedBadRef.current) {
      committedBadRef.current = false;
      toast.success("Conexión restablecida", { description: "Tu internet volvió a la normalidad." });
    }
  }, [connQuality]);

  // ── Price alerts ─────────────────────────────────────────────────────────
  const {
    alerts: priceAlerts,
    triggered: triggeredAlerts,
    unread: alertsUnread,
    addAlert,
    removeAlert,
    triggerAlert,
    markRead: markAlertsRead,
    clearTriggered: clearTriggeredAlerts,
  } = usePriceAlerts();

  const getSymbolPrice = useCallback(
    (sym: string): number | null => {
      if (!dbAccountId) return null;
      const t = liveTicks.get(`${dbAccountId}::${sym}`);
      const pr = t?.last ?? t?.bid ?? null;
      return pr && pr > 0 ? pr : null;
    },
    [dbAccountId, liveTicks],
  );

  // Short synthesized beep (Web Audio) for sound effects — no audio asset needed.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playBeep = useCallback((freq = 880, ms = 160) => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtxRef.current) audioCtxRef.current = new Ctx();
      const ctx = audioCtxRef.current;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + ms / 1000);
    } catch {
      /* ignore */
    }
  }, []);

  // Stream ticks for any symbol that has an active alert (besides the watchlist).
  useEffect(() => {
    if (!dbAccountId || !marketConnected || priceAlerts.length === 0) return;
    const syms = Array.from(new Set(priceAlerts.map((a) => a.symbol)));
    syms.forEach((s) => socketSubscribe(dbAccountId, s));
    return () => syms.forEach((s) => socketUnsubscribe(dbAccountId, s));
  }, [priceAlerts, dbAccountId, marketConnected, socketSubscribe, socketUnsubscribe]);

  // Fire alerts when the live price crosses their target.
  useEffect(() => {
    if (!dbAccountId || priceAlerts.length === 0) return;
    for (const a of priceAlerts) {
      const t = liveTicks.get(`${dbAccountId}::${a.symbol}`);
      const price = t?.last ?? t?.bid;
      if (price == null || price <= 0) continue;
      const hit = a.direction === "up" ? price >= a.target : price <= a.target;
      if (hit) {
        triggerAlert(a, price);
        if (settings.soundAlerts) playBeep();
        toast.success(
          `Alerta: ${formatSymbolDisplay(a.symbol)} ${a.direction === "up" ? "subió a" : "bajó a"} ${a.target}`,
          { description: `Precio actual ${price.toFixed(price < 20 ? 5 : 2)}` },
        );
        if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification("Alerta de precio · Kai", {
              body: `${formatSymbolDisplay(a.symbol)} alcanzó ${a.target}`,
            });
          } catch {
            /* ignore */
          }
        }
      }
    }
  }, [liveTicks, dbAccountId, priceAlerts, triggerAlert, settings.soundAlerts, playBeep]);

  const openAlerts = useCallback(() => {
    setAlertsOpen(true);
    markAlertsRead();
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, [markAlertsRead]);

  const symbolList = useMemo(() => {
    // Dedup por display: el bróker expone variantes distintas que colapsan al
    // mismo nombre visible (p.ej. `USTECm` y `USTEC_x100m` → "USTEC"), lo que
    // producía filas repetidas en la watchlist. Nos quedamos con UNA por
    // display, prefiriendo la variante "limpia" (sin el escalado `_x100`).
    const byDisplay = new Map<string, { name: string; display: string; category: string }>();
    const isScaledVariant = (name: string) => /_x\d+/i.test(name);
    for (const [category, list] of Object.entries(groupedSymbols ?? {})) {
      for (const sym of list as Array<{ name: string; description?: string | null }>) {
        const display = formatSymbolDisplay(sym.name);
        const existing = byDisplay.get(display);
        if (!existing || (isScaledVariant(existing.name) && !isScaledVariant(sym.name))) {
          byDisplay.set(display, { name: sym.name, display, category });
        }
      }
    }
    const result = Array.from(byDisplay.values());
    // Most-liquid instruments first (BTC, ETH, XAU, EUR…) so the watchlist is
    // useful and the default selection has a live price, instead of starting
    // alphabetically on an illiquid token with no price.
    result.sort(compareSymbols);
    return result;
  }, [groupedSymbols]);

  const filteredSymbols = useMemo(() => {
    return symbolList.filter((s) => categoryFilter === "TODO" || s.category === categoryFilter);
  }, [symbolList, categoryFilter]);

  // The catalog is only trustworthy for validation/defaults once it was
  // fetched for THIS account: while switching accounts the hook still holds
  // the previous account's symbols (see useAccountSymbols.loadedForAccountId).
  const catalogReady =
    !symbolsLoading && loadedForAccountId != null && loadedForAccountId === dbAccountId && symbols.length > 0;
  const validSymbolNames = useMemo(() => new Set(symbols.map((s) => s.name)), [symbols]);

  // When the active account's catalog is in, drop any symbol dragged over
  // from a previously-viewed account (e.g. BTCUSDm lingering on a sim-futures
  // account whose catalog is only the 8 CME roots): prune stale tabs and clear
  // the selection so the default-pick effect below re-selects from THIS
  // catalog. Valid persisted tabs are untouched (MT5/Rithmic flow unchanged).
  useEffect(() => {
    if (!catalogReady) return;
    setOpenSymbols((prev) => {
      const next = prev.filter((s) => validSymbolNames.has(s));
      return next.length === prev.length ? prev : next;
    });
    setSelectedSymbol((cur) => (cur && !validSymbolNames.has(cur) ? "" : cur));
  }, [catalogReady, validSymbolNames]);

  useEffect(() => {
    if (selectedSymbol) return;
    if (openSymbols.length > 0) {
      setSelectedSymbol(openSymbols[0]);
      return;
    }
    // Default pick comes from the catalog, so wait until it belongs to the
    // active account — otherwise an account switch could stamp the previous
    // account's first symbol into this account's tabs (and localStorage).
    if (!catalogReady) return;
    if (filteredSymbols.length > 0) {
      // Prefer MNQ when the account offers it (sim/futures catalogs); fall
      // back to the liquidity-sorted first symbol exactly as before.
      const preferred = filteredSymbols.find(
        (s) => s.name === PREFERRED_DEFAULT_SYMBOL || s.display === PREFERRED_DEFAULT_SYMBOL,
      );
      const first = (preferred ?? filteredSymbols[0]).name;
      setSelectedSymbol(first);
      setOpenSymbols([first]);
    }
  }, [filteredSymbols, selectedSymbol, openSymbols, catalogReady]);

  // Live-price the watchlist for only a bounded set of symbols. The backend
  // polls every subscribed symbol against a single (serial) MT5 terminal every
  // 500ms, so subscribing to all ~355 symbols saturates it, trips the bridge
  // circuit breaker, and then even chart candles fail ("Sin datos"). Cap it.
  const liveWatchlistSymbols = useMemo(
    () => filteredSymbols.slice(0, WATCHLIST_LIVE_CAP).map((s) => s.name),
    [filteredSymbols],
  );

  useEffect(() => {
    if (!dbAccountId || !marketConnected || liveWatchlistSymbols.length === 0) return;
    liveWatchlistSymbols.forEach((name) => socketSubscribe(dbAccountId, name));
    return () => {
      liveWatchlistSymbols.forEach((name) => socketUnsubscribe(dbAccountId, name));
    };
  }, [liveWatchlistSymbols, dbAccountId, marketConnected, socketSubscribe, socketUnsubscribe]);

  useEffect(() => {
    if (!dbAccountId || !marketConnected) return;
    const syms = Array.from(new Set([selectedSymbol, ...openSymbols].filter(Boolean)));
    if (syms.length === 0) return;
    syms.forEach((s) => socketSubscribe(dbAccountId, s));
    return () => syms.forEach((s) => socketUnsubscribe(dbAccountId, s));
  }, [selectedSymbol, openSymbols, dbAccountId, marketConnected, socketSubscribe, socketUnsubscribe]);

  // Fallback price from the latest candle so the trade panel is usable even
  // before the first live tick arrives (or while a symbol is quiet). Shares the
  // chart's React Query cache, so it's not an extra request. Market orders fill
  // at the broker's live price regardless — this is just the reference shown.
  const { data: fallbackCandles = EMPTY_LIST } = useMarketCandles(dbAccountId, selectedSymbol, timeframe, 2);
  const fallbackPrice = fallbackCandles[fallbackCandles.length - 1]?.close ?? 0;

  const selectedTick = dbAccountId ? liveTicks.get(`${dbAccountId}::${selectedSymbol}`) ?? null : null;
  const bidPrice = selectedTick?.bid ?? fallbackPrice;
  const askPrice = selectedTick?.ask ?? fallbackPrice;
  const lastPrice = selectedTick?.last ?? bidPrice ?? askPrice;
  const spread = selectedTick && selectedTick.bid > 0 && selectedTick.ask > 0 ? selectedTick.ask - selectedTick.bid : 0;
  const notional = (parseFloat(volume) || 0) * bidPrice;

  // Contract spec for the selected futures symbol (tick size/value) — sourced
  // from the `/symbols` payload (AccountSymbol.tick_size / tick_value). Only
  // meaningful in futures mode; null otherwise so the ticket falls back to CFD.
  const tickSpec = useMemo<FuturesTickSpec | null>(() => {
    if (terminalMode !== "futures" || !selectedSymbol) return null;
    const sym = symbols.find((s) => s.name === selectedSymbol);
    if (!sym) return null;
    if (!(sym.tick_size > 0) || !(sym.tick_value > 0)) return null;
    return { tickSize: sym.tick_size, tickValue: sym.tick_value };
  }, [terminalMode, selectedSymbol, symbols]);

  const tpNum = parseFloat(takeProfitPrice) || 0;
  const slNum = parseFloat(stopLossPrice) || 0;
  const risk = slNum > 0 ? Math.abs(lastPrice - slNum) * (parseFloat(volume) || 0) : 0;
  const reward = tpNum > 0 ? Math.abs(tpNum - lastPrice) * (parseFloat(volume) || 0) : 0;

  // ── Preview de orden EDITABLE en el chart (drag de SL/TP → este form) ────────
  // Redondea al tick del símbolo al soltar un handle.
  const roundToTickStr = useCallback(
    (p: number) => {
      const ts =
        tickSpec?.tickSize && tickSpec.tickSize > 0 ? tickSpec.tickSize : null;
      const v = ts ? Math.round(p / ts) * ts : p;
      return String(Number(v.toFixed(ts && ts < 1 ? 4 : 2)));
    },
    [tickSpec?.tickSize],
  );
  const orderPreview = useMemo(() => {
    const tpOn = takeProfitEnabled && tpNum > 0;
    const slOn = stopLossEnabled && slNum > 0;
    if ((!tpOn && !slOn) || !(lastPrice > 0)) return null;
    return {
      side: "buy" as const, // las zonas verde(TP)/roja(SL) no dependen del lado
      entry: lastPrice,
      tp: tpOn ? tpNum : 0,
      sl: slOn ? slNum : 0,
    };
  }, [takeProfitEnabled, stopLossEnabled, tpNum, slNum, lastPrice]);

  const errorMessage = (e: unknown, fallback: string) => {
    const raw = e instanceof Error && e.message ? e.message : "";
    // Surface broker market-hours rejections in plain language instead of the
    // raw "MT5 bridge ... 503 close_rejected" string. Forex/indices are closed
    // on weekends/daily breaks; only crypto trades 24/7.
    if (/close_rejected|market.*closed|mercado.*cerrad|trade.*disabled|10018|10019|market is closed/i.test(raw)) {
      return "Mercado cerrado para este instrumento ahora mismo. Intenta cuando abra (forex/índices cierran fines de semana; cripto opera 24/7).";
    }
    if (/modify_rejected|invalid_stops|10016|too close/i.test(raw)) {
      return "El broker rechazó los niveles: revisa que el SL/TP esté del lado correcto y no demasiado cerca del precio.";
    }
    return raw || fallback;
  };

  const confirm = useConfirm();

  const handlePlaceOrder = useCallback(
    async (side: TradingOrderSide) => {
      // Phase 4: futures order placement is intentionally not wired (Phase 5,
      // money-critical). The BUY/SELL buttons are disabled for Rithmic accounts;
      // this guard is defence-in-depth so we never hit the backend "not
      // supported" path.
      if (!strategy.ordersEnabled) return;
      if (!dbAccountId || !selectedSymbol || bidPrice <= 0) return;
      const lots = parseFloat(volume) || 0;
      // Futuros → "contrato(s)"; CFD/forex (MT5) → "lote(s)". No mezclar la
      // terminología entre modos.
      const unit = terminalMode === "futures" ? "contrato" : "lote";
      // One-click mode fires immediately without the confirmation dialog (Exness
      // "Formulario con un clic"). Regular/risk modes still confirm.
      if (orderMode !== "oneClick") {
        const ok = await confirm({
          title: `${side === "buy" ? "COMPRAR" : "VENDER"} ${formatSymbolDisplay(selectedSymbol)}`,
          description: `Operación REAL a mercado: ${lots} ${unit}(s) de ${formatSymbolDisplay(selectedSymbol)}.\n¿Confirmas la ejecución?`,
          confirmText: side === "buy" ? "Comprar" : "Vender",
          destructive: side === "sell",
        });
        if (!ok) return;
      }
      // The execution backend only supports market orders; the order-type
      // selector is informational and Market is the only enabled option.
      // `entry` is the approximate fill price (BUY→ask, SELL→bid): the Rithmic
      // futures bridge needs it to turn absolute SL/TP into its tick-distance
      // bracket (GATE 2). MT5 ignores it, so it's attached for every provider.
      const entry = resolveOrderEntryPrice({
        side,
        bid: bidPrice,
        ask: askPrice,
        fallback: fallbackPrice,
      });
      try {
        await placeOrder.mutateAsync({
          tradingAccountId: dbAccountId,
          symbol: selectedSymbol,
          side,
          type: "market",
          volume: lots,
          takeProfit: takeProfitEnabled && tpNum > 0 ? tpNum : 0,
          stopLoss: stopLossEnabled && slNum > 0 ? slNum : 0,
          entry: entry > 0 ? entry : undefined,
          confirmationText: REAL_CONFIRMATION_TEXT,
        });
        toast.success(
          `${side === "buy" ? "Compra" : "Venta"} ejecutada · ${lots} ${unit}s ${selectedSymbol}`,
          {
            // Click → abre la pestaña ÓRDENES de la cuenta activa (donde se ejecutó).
            action: {
              label: "Ver órdenes",
              onClick: () => {
                setBottomTab("ORDENES");
                setBottomOpen(true);
              },
            },
          },
        );
      } catch (e) {
        toast.error(errorMessage(e, "No se pudo ejecutar la orden"));
      }
    },
    [confirm, dbAccountId, selectedSymbol, bidPrice, askPrice, fallbackPrice, placeOrder, volume, takeProfitEnabled, tpNum, stopLossEnabled, slNum, orderMode, strategy.ordersEnabled, terminalMode],
  );

  const handleClosePosition = useCallback(
    async (position: CopyTradingPosition) => {
      if (!dbAccountId) return;
      const ok = await confirm({
        title: `Cerrar posición #${position.id}`,
        description: `Se cerrará la posición de ${formatSymbolDisplay(position.symbol)} a precio de mercado. Operación REAL.`,
        confirmText: "Cerrar posición",
        destructive: true,
      });
      if (!ok) return;
      try {
        await closePosition.mutateAsync({
          ticket: String(position.id),
          tradingAccountId: dbAccountId,
          dryRun: false,
          confirmationText: REAL_CONFIRMATION_TEXT,
        });
        toast.success(`Posición #${position.id} cerrada`);
      } catch (e) {
        toast.error(errorMessage(e, "No se pudo cerrar la posición"));
      }
    },
    [confirm, dbAccountId, closePosition],
  );

  const closePositionsBatch = useCallback(
    async (list: CopyTradingPosition[]) => {
      if (!dbAccountId || list.length === 0) return;
      setClosingBatch(true);
      let ok = 0;
      let failed = 0;
      let lastError: unknown = null;
      for (const position of list) {
        try {
          await closePosition.mutateAsync({
            ticket: String(position.id),
            tradingAccountId: dbAccountId,
            dryRun: false,
            confirmationText: REAL_CONFIRMATION_TEXT,
          });
          ok += 1;
        } catch (e) {
          failed += 1;
          lastError = e;
        }
      }
      setClosingBatch(false);
      setCloseAllOpen(false);
      if (ok > 0) toast.success(`${ok} posición(es) cerrada(s)${failed ? `, ${failed} fallida(s)` : ""}`);
      else if (failed > 0) toast.error(errorMessage(lastError, `No se pudieron cerrar ${failed} posición(es)`));
    },
    [dbAccountId, closePosition],
  );

  const handleUpdateStops = useCallback(
    async (position: CopyTradingPosition, sl?: number | null, tp?: number | null) => {
      if (!dbAccountId) return;
      const isBuy = position.side === "LONG";
      const ref = position.currentPrice || position.avgPrice;
      const tpv = tp ?? 0;
      const slv = sl ?? 0;
      // Validate sides before the broker rejects with "modify_rejected".
      if (tpv > 0 && ref > 0 && ((isBuy && tpv <= ref) || (!isBuy && tpv >= ref))) {
        toast.error("Take Profit inválido", { description: `Debe estar ${isBuy ? "por encima" : "por debajo"} del precio actual (${ref}).` });
        return;
      }
      if (slv > 0 && ref > 0 && ((isBuy && slv >= ref) || (!isBuy && slv <= ref))) {
        toast.error("Stop Loss inválido", { description: `Debe estar ${isBuy ? "por debajo" : "por encima"} del precio actual (${ref}).` });
        return;
      }
      try {
        await updateStops.mutateAsync({
          ticket: String(position.id),
          tradingAccountId: dbAccountId,
          stopLoss: slv,
          takeProfit: tpv,
          dryRun: false,
          confirmationText: REAL_CONFIRMATION_TEXT,
        });
        toast.success(`Stops actualizados · #${position.id}`);
      } catch (e) {
        toast.error(errorMessage(e, "No se pudieron actualizar los stops"));
      }
    },
    [dbAccountId, updateStops],
  );

  const uiPositions = useMemo<CopyTradingPosition[]>(
    () =>
      positions
        .map((p) => toUiPosition(p, resolvedAccount?.name ?? ""))
        // Newest trade first (most recent open time at the top).
        .sort((a, b) => {
          const ta = a.openedAtIso ? Date.parse(a.openedAtIso) : 0;
          const tb = b.openedAtIso ? Date.parse(b.openedAtIso) : 0;
          return tb - ta;
        }),
    [positions, resolvedAccount],
  );

  // Cablea la '×' de las cajas de posición del chart (kaiPositionBox) al mismo
  // flujo de cierre REAL del terminal (confirmación + risk gate). El overlay pasa
  // ticket = String(position.id); lo resolvemos contra las posiciones visibles.
  useEffect(() => {
    setKaiPositionCloseHandler((ticket) => {
      const pos = uiPositions.find((p) => String(p.id) === ticket);
      if (pos) void handleClosePosition(pos);
    });
    return () => setKaiPositionCloseHandler(null);
  }, [uiPositions, handleClosePosition]);

  const totalPnl = useMemo(
    () => uiPositions.reduce((acc, p) => acc + (p.openPnlUsd ?? 0), 0),
    [uiPositions],
  );

  // Open position for the ACTIVE symbol (drives the futures ticket's "Active
  // Positions" line + CLOSE POSITION button). Matched by broker symbol and, as a
  // fallback, by display name so scaled/variant symbols still resolve.
  const activePosition = useMemo<CopyTradingPosition | null>(() => {
    if (!selectedSymbol) return null;
    const disp = formatSymbolDisplay(selectedSymbol);
    return (
      uiPositions.find((p) => p.symbol === selectedSymbol || formatSymbolDisplay(p.symbol) === disp) ?? null
    );
  }, [uiPositions, selectedSymbol]);

  // Fase B — bulk/flip futures actions. All server-gated by
  // RITHMIC_TERMINAL_ORDERS_ENABLED + the account capability flag (the buttons
  // stay disabled while ordersEnabled is false), and each requires an explicit
  // REAL confirmation before it executes (dryRun:false + confirmationText).
  const onFlattenAll = useCallback(async () => {
    if (!dbAccountId) return;
    const ok = await confirm({
      title: "Flatten all",
      description:
        "Se cerrarán TODAS las posiciones abiertas de esta cuenta a precio de mercado y se cancelarán sus órdenes de entrada. Operación REAL.",
      confirmText: "Flatten all",
      destructive: true,
    });
    if (!ok) return;
    try {
      await flattenAll.mutateAsync({
        tradingAccountId: dbAccountId,
        dryRun: false,
        confirmationText: REAL_CONFIRMATION_TEXT,
      });
      toast.success("Todas las posiciones cerradas");
    } catch (e) {
      toast.error(errorMessage(e, "No se pudo hacer flatten all"));
    }
  }, [confirm, dbAccountId, flattenAll]);

  const onCancelAll = useCallback(async () => {
    if (!dbAccountId) return;
    const ok = await confirm({
      title: "Cancelar órdenes",
      description:
        "Se cancelarán TODAS las órdenes de trabajo (pendientes) de esta cuenta. No cierra posiciones abiertas. Operación REAL.",
      confirmText: "Cancelar órdenes",
      destructive: true,
    });
    if (!ok) return;
    try {
      await cancelAll.mutateAsync({
        tradingAccountId: dbAccountId,
        dryRun: false,
        confirmationText: REAL_CONFIRMATION_TEXT,
      });
      toast.success("Órdenes canceladas");
    } catch (e) {
      toast.error(errorMessage(e, "No se pudieron cancelar las órdenes"));
    }
  }, [confirm, dbAccountId, cancelAll]);

  const onReverse = useCallback(async () => {
    if (!dbAccountId || !activePosition) return;
    // Reverse requires a protective SL: the Rithmic per-trade risk gate is
    // fail-closed and refuses a flip that can't be bounded. Ask the user to set
    // one (via the OCO/Bracket toggle) instead of silently sending a naked flip.
    const sl = stopLossEnabled ? parseFloat(stopLossPrice) : NaN;
    if (!Number.isFinite(sl) || sl <= 0) {
      toast.error("Reverse necesita un Stop Loss", {
        description:
          "Activá OCO/Bracket y definí el SL de la posición revertida antes de revertir.",
      });
      return;
    }
    const tp = takeProfitEnabled ? parseFloat(takeProfitPrice) : NaN;
    // New position enters opposite: LONG→SHORT fills ~bid, SHORT→LONG fills ~ask.
    const newEntry = activePosition.side === "LONG" ? bidPrice : askPrice;
    const ok = await confirm({
      title: `Revertir ${formatSymbolDisplay(activePosition.symbol)}`,
      description:
        "Se cerrará la posición actual y se abrirá una OPUESTA del mismo tamaño (sujeto al cap de contratos y al riesgo por trade). Operación REAL.",
      confirmText: "Revertir posición",
      destructive: true,
    });
    if (!ok) return;
    try {
      await reversePos.mutateAsync({
        tradingAccountId: dbAccountId,
        ticket: String(activePosition.id),
        stopLoss: sl,
        takeProfit: Number.isFinite(tp) && tp > 0 ? tp : null,
        entry: newEntry > 0 ? newEntry : null,
        dryRun: false,
        confirmationText: REAL_CONFIRMATION_TEXT,
      });
      toast.success("Posición revertida");
    } catch (e) {
      toast.error(errorMessage(e, "No se pudo revertir la posición"));
    }
  }, [
    confirm,
    dbAccountId,
    activePosition,
    stopLossEnabled,
    stopLossPrice,
    takeProfitEnabled,
    takeProfitPrice,
    bidPrice,
    askPrice,
    reversePos,
  ]);

  // Beep when a position disappears (closed by TP/SL/SO or manually). Reset the
  // baseline on account switch so changing accounts never sounds a false close.
  const prevPosRef = useRef<{ account: string | null; ids: Set<string> }>({ account: null, ids: new Set() });
  useEffect(() => {
    if (positionsLoading) return;
    const ids = new Set(uiPositions.map((p) => String(p.id)));
    const prev = prevPosRef.current;
    if (prev.account === dbAccountId && prev.ids.size > 0) {
      let closed = false;
      prev.ids.forEach((id) => {
        if (!ids.has(id)) closed = true;
      });
      if (closed && settings.soundClose) playBeep(523, 220);
    }
    prevPosRef.current = { account: dbAccountId, ids };
  }, [uiPositions, dbAccountId, positionsLoading, settings.soundClose, playBeep]);

  return (
    <div className="flex flex-col h-[100dvh] w-screen bg-[#0a0c12] text-white overflow-hidden">
      <TopHeader
        accountName={resolvedAccount?.name ?? (accountsLoading ? "Cargando..." : "Sin cuenta")}
        accountNumber={accountId ?? resolvedAccount?.providerAccountId ?? "—"}
        accounts={routeAccounts as Array<{ id: string; name: string; providerAccountId?: string | null; status?: string }>}
        onSelect={(id) => {
          const url = new URL(window.location.href);
          url.searchParams.set("account", id);
          window.location.href = url.toString();
        }}
        marketConnected={marketConnected}
        connQuality={connQuality}
        latencyMs={latency.latencyMs}
        alertsUnread={alertsUnread}
        onBellClick={openAlerts}
        onSettingsClick={() => setSettingsOpen(true)}
        onToggleMobilePanel={(p) => setMobilePanel((cur) => (cur === p ? null : p))}
        activeMobilePanel={mobilePanel}
        equity={(resolvedAccount as { equity?: number | null } | null)?.equity ?? null}
        currentBalance={(resolvedAccount as { balance?: number | null } | null)?.balance ?? null}
        unrealizedPnl={uiPositions.length > 0 ? totalPnl : 0}
        netDailyPnl={(resolvedAccount as { netDailyPnl?: number | null } | null)?.netDailyPnl ?? null}
        sodBalance={(resolvedAccount as { sodBalance?: number | null } | null)?.sodBalance ?? null}
        openSymbols={openSymbols}
        selectedSymbol={selectedSymbol}
        onSelectTab={setSelectedSymbol}
        onCloseTab={closeSymbol}
        onAddTab={openSymbol}
        symbolList={symbolList}
        getPrice={getSymbolPrice}
      />
      <CloseAllDialog
        open={closeAllOpen}
        onOpenChange={setCloseAllOpen}
        positions={uiPositions}
        busy={closingBatch}
        onConfirm={closePositionsBatch}
      />
      <AlertsDialog
        open={alertsOpen}
        onOpenChange={setAlertsOpen}
        symbols={symbolList}
        defaultSymbol={selectedSymbol}
        getPrice={getSymbolPrice}
        alerts={priceAlerts}
        triggered={triggeredAlerts}
        onAdd={(sym, target) => addAlert(sym, target, getSymbolPrice(sym) ?? target)}
        onRemove={removeAlert}
        onClearTriggered={clearTriggeredAlerts}
      />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        setSetting={setSetting}
      />
      <div className="flex flex-1 overflow-hidden relative">
        <aside
          className={cn(
            "shrink-0 bg-[#0d0f16] flex flex-col overflow-hidden transition-all duration-200",
            "hidden md:flex",
            watchlistOpen ? "w-64 border-r border-white/10" : "w-0 border-r-0",
          )}
        >
          <Watchlist
            items={filteredSymbols}
            ticks={liveTicks as ReadonlyMap<string, { bid: number; ask: number; last: number }>}
            dbAccountId={dbAccountId}
            loading={symbolsLoading}
            selected={selectedSymbol}
            onSelect={openSymbol}
            categoryFilter={categoryFilter}
            onCategoryChange={setCategoryFilter}
          />
        </aside>

        {mobilePanel === "watchlist" && (
          <div className="md:hidden absolute inset-0 z-40 bg-[#0d0f16] flex flex-col">
            <div className="flex items-center justify-between p-3 border-b border-white/10">
              <span className="text-sm font-semibold">Watchlist</span>
              <Button variant="ghost" size="icon" onClick={() => setMobilePanel(null)} className="h-8 w-8">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <Watchlist
              items={filteredSymbols}
              ticks={liveTicks as ReadonlyMap<string, { bid: number; ask: number; last: number }>}
              dbAccountId={dbAccountId}
              loading={symbolsLoading}
              selected={selectedSymbol}
              onSelect={openSymbol}
              categoryFilter={categoryFilter}
              onCategoryChange={setCategoryFilter}
            />
          </div>
        )}

        <div className="flex-1 flex flex-col overflow-hidden min-w-0">
          {USE_CHART_PRO && (
            <FavTimeframeBar timeframe={timeframe} onSelect={setTimeframe} />
          )}
          <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
            {USE_CHART_PRO ? (
              <ErrorBoundary
                fallback={
                  <KaiChart
                    symbol={selectedSymbol}
                    accountId={dbAccountId}
                    positions={uiPositions}
                    historyTrades={historyTrades}
                    timeframe={timeframe}
                    onTimeframeChange={setTimeframe}
                    showPositions={settings.showPositions}
                    showTpSl={settings.showTpSl}
                    timezone={settings.timezone}
                  />
                }
              >
                <KaiChartPro
                  symbol={selectedSymbol}
                  accountId={dbAccountId}
                  positions={uiPositions}
                  historyTrades={historyTrades}
                  timeframe={timeframe}
                  timezone={settings.timezone}
                  showPositions={settings.showPositions}
                  showTpSl={settings.showTpSl}
                  tickSize={tickSpec?.tickSize ?? null}
                  tickValue={tickSpec?.tickValue ?? null}
                  onSymbolChange={openSymbol}
                  onPeriodChange={setTimeframe}
                  focusTrade={focusTrade}
                  orderPreview={orderPreview}
                  onOrderTpChange={(p) => setTakeProfitPrice(roundToTickStr(p))}
                  onOrderSlChange={(p) => setStopLossPrice(roundToTickStr(p))}
                />
              </ErrorBoundary>
            ) : (
              <KaiChart
                symbol={selectedSymbol}
                accountId={dbAccountId}
                positions={uiPositions}
                historyTrades={historyTrades}
                timeframe={timeframe}
                onTimeframeChange={setTimeframe}
                showPositions={settings.showPositions}
                showTpSl={settings.showTpSl}
                timezone={settings.timezone}
              />
            )}

            {/* Toggles de paneles laterales (solo desktop, donde existen los
                asides): pestañas flotantes sobre los bordes del chart, estilo
                TradingView. El chevron apunta hacia la acción resultante. */}
            <button
              type="button"
              onClick={() => setWatchlistOpen((v) => !v)}
              title={watchlistOpen ? "Ocultar watchlist" : "Mostrar watchlist"}
              aria-label={watchlistOpen ? "Ocultar watchlist" : "Mostrar watchlist"}
              className="hidden md:flex absolute left-0 bottom-3 z-30 h-12 w-5 items-center justify-center rounded-r border border-l-0 border-white/10 bg-[#0d0f16]/90 text-white/50 hover:bg-[#151824] hover:text-white"
            >
              {watchlistOpen ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => setOrderPanelOpen((v) => !v)}
              title={orderPanelOpen ? "Ocultar panel de orden" : "Mostrar panel de orden"}
              aria-label={orderPanelOpen ? "Ocultar panel de orden" : "Mostrar panel de orden"}
              className="hidden lg:flex absolute right-0 bottom-3 z-30 h-12 w-5 items-center justify-center rounded-l border border-r-0 border-white/10 bg-[#0d0f16]/90 text-white/50 hover:bg-[#151824] hover:text-white"
            >
              {orderPanelOpen ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </button>
          </div>
          <div className={cn("border-t border-white/10 bg-[#0d0f16] flex flex-col", bottomOpen ? "h-64" : "h-9")}>
            <div className="flex items-center justify-between border-b border-white/10 px-2 sm:px-3 py-1.5">
              <div className="flex gap-2 sm:gap-4 text-xs overflow-x-auto">
                {(["CUENTAS", "POSICIONES", "ORDENES"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => {
                      setBottomTab(t);
                      setBottomOpen(true);
                    }}
                    className={cn(
                      "font-semibold tracking-wider pb-1 transition-colors whitespace-nowrap",
                      bottomTab === t && bottomOpen ? "text-white border-b-2 border-[#2f6bff]" : "text-white/50 hover:text-white/80",
                    )}
                  >
                    {t === "CUENTAS"
                      ? `CUENTAS (${routeAccounts.length})`
                      : t === "POSICIONES"
                        ? `POSICIONES (${positions.length})`
                        : `ÓRDENES (${orders.length + historyTrades.length})`}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                {bottomTab === "POSICIONES" && positions.length > 0 && bottomOpen && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setCloseAllOpen(true)}
                    className="h-7 text-xs border-[#ef5350]/40 text-[#ef5350] hover:bg-[#ef5350]/10 hover:text-[#ef6863]"
                  >
                    CERRAR TODO
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setBottomOpen((v) => !v)}
                >
                  {bottomOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            {bottomOpen && (
              <BottomPanel
                positions={uiPositions}
                loading={positionsLoading}
                activeTab={bottomTab}
                accounts={routeAccounts as Array<{ id: string; name: string; providerAccountId?: string | null; status?: string; accountType?: string | null; balance?: number | null; equity?: number | null }>}
                totalPnl={totalPnl}
                balance={(resolvedAccount as { balance?: number | null } | null)?.balance ?? null}
                equity={(resolvedAccount as { equity?: number | null } | null)?.equity ?? null}
                marginFree={(resolvedAccount as { equity?: number | null } | null)?.equity ?? null}
                onClose={handleClosePosition}
                onUpdateStops={handleUpdateStops}
                orders={orders}
                historyTrades={historyTrades}
                onFocusTrade={handleFocusTrade}
                onFocusPosition={handleFocusPosition}
                unitLabel={strategy.unitLabel}
                accountName={resolvedAccount?.name ?? "—"}
              />
            )}
          </div>
        </div>

        <aside
          className={cn(
            "shrink-0 bg-[#0d0f16] flex flex-col overflow-hidden transition-all duration-200",
            "hidden lg:flex",
            orderPanelOpen ? "w-80 border-l border-white/10" : "w-0 border-l-0",
          )}
        >
          <TradePanel
            bidPrice={bidPrice}
            askPrice={askPrice}
            spread={spread}
            symbol={selectedSymbol}
            orderType={orderType}
            setOrderType={setOrderType}
            volume={volume}
            setVolume={setVolume}
            takeProfitEnabled={takeProfitEnabled}
            setTakeProfitEnabled={setTakeProfitEnabled}
            takeProfitPrice={takeProfitPrice}
            setTakeProfitPrice={setTakeProfitPrice}
            stopLossEnabled={stopLossEnabled}
            setStopLossEnabled={setStopLossEnabled}
            stopLossPrice={stopLossPrice}
            setStopLossPrice={setStopLossPrice}
            notional={notional}
            risk={risk}
            reward={reward}
            onSubmit={handlePlaceOrder}
            submitting={placeOrder.isPending}
            lastPrice={lastPrice}
            orderMode={orderMode}
            setOrderMode={setOrderMode}
            capital={(resolvedAccount as { equity?: number | null } | null)?.equity ?? null}
            autoTpSl={settings.autoTpSl}
            strategy={strategy}
            tickSpec={tickSpec}
            maxContracts={maxContracts}
            activePosition={activePosition}
            onClosePosition={activePosition ? () => handleClosePosition(activePosition) : undefined}
            onReverse={onReverse}
            onFlattenAll={onFlattenAll}
            onCancelAll={onCancelAll}
          />
        </aside>

        {mobilePanel === "trade" && (
          <div className="lg:hidden absolute inset-0 z-40 bg-[#0d0f16] flex flex-col overflow-y-auto">
            <div className="flex items-center justify-between p-3 border-b border-white/10 sticky top-0 bg-[#0d0f16] z-10">
              <span className="text-sm font-semibold">Operar</span>
              <Button variant="ghost" size="icon" onClick={() => setMobilePanel(null)} className="h-8 w-8">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <TradePanel
              bidPrice={bidPrice}
              askPrice={askPrice}
              spread={spread}
              symbol={selectedSymbol}
              orderType={orderType}
              setOrderType={setOrderType}
              volume={volume}
              setVolume={setVolume}
              takeProfitEnabled={takeProfitEnabled}
              setTakeProfitEnabled={setTakeProfitEnabled}
              takeProfitPrice={takeProfitPrice}
              setTakeProfitPrice={setTakeProfitPrice}
              stopLossEnabled={stopLossEnabled}
              setStopLossEnabled={setStopLossEnabled}
              stopLossPrice={stopLossPrice}
              setStopLossPrice={setStopLossPrice}
              notional={notional}
              risk={risk}
              reward={reward}
              onSubmit={handlePlaceOrder}
              submitting={placeOrder.isPending}
              lastPrice={lastPrice}
              orderMode={orderMode}
              setOrderMode={setOrderMode}
              capital={(resolvedAccount as { equity?: number | null } | null)?.equity ?? null}
              autoTpSl={settings.autoTpSl}
              strategy={strategy}
              tickSpec={tickSpec}
              maxContracts={maxContracts}
              activePosition={activePosition}
              onClosePosition={activePosition ? () => handleClosePosition(activePosition) : undefined}
              onReverse={onReverse}
              onFlattenAll={onFlattenAll}
              onCancelAll={onCancelAll}
            />
          </div>
        )}
      </div>

      {/* Acceso rápido de trading en móvil (estilo Exness): SELL/BUY con el
          precio vivo del símbolo activo. NO ejecutan — abren el sheet Operar
          con el formulario completo (riesgo de fat-finger fuera). Mismos
          colores que los CTAs BUY/SELL @ MARKET de desktop. */}
      <div className="md:hidden flex gap-1.5 border-t border-white/10 bg-[#0d0f16] px-2 py-1.5 shrink-0">
        <button
          onClick={() => setMobilePanel("trade")}
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-[#e0413d] active:bg-[#ef5350] transition-colors"
        >
          <span className="text-[10px] font-bold uppercase tracking-wider text-white/80">Sell</span>
          <span className="text-[13px] font-bold tabular-nums text-white">
            {bidPrice > 0 ? bidPrice : "—"}
          </span>
        </button>
        <button
          onClick={() => setMobilePanel("trade")}
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-[#1aa86a] active:bg-[#1fbd78] transition-colors"
        >
          <span className="text-[10px] font-bold uppercase tracking-wider text-white/80">Buy</span>
          <span className="text-[13px] font-bold tabular-nums text-white">
            {askPrice > 0 ? askPrice : "—"}
          </span>
        </button>
      </div>

      <div className="md:hidden flex items-center justify-around border-t border-white/10 bg-[#0d0f16] py-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setMobilePanel((cur) => (cur === "watchlist" ? null : "watchlist"))}
          className={cn("flex flex-col items-center text-[10px] h-auto py-1 px-3", mobilePanel === "watchlist" ? "text-emerald-400" : "text-white/60")}
        >
          <Search className="h-4 w-4 mb-0.5" />
          Símbolos
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setMobilePanel((cur) => (cur === "trade" ? null : "trade"))}
          className={cn("flex flex-col items-center text-[10px] h-auto py-1 px-3", mobilePanel === "trade" ? "text-emerald-400" : "text-white/60")}
        >
          <Menu className="h-4 w-4 mb-0.5" />
          Operar
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setBottomTab("POSICIONES");
            setBottomOpen(true);
          }}
          className="flex flex-col items-center text-[10px] h-auto py-1 px-3 text-white/60"
        >
          <Badge className="bg-emerald-500/15 text-emerald-400 border-0 px-2 mb-0.5">{positions.length}</Badge>
          Posiciones
        </Button>
      </div>
    </div>
  );
}

function TopHeader({
  accountName,
  accountNumber,
  accounts,
  onSelect,
  marketConnected,
  connQuality,
  latencyMs,
  alertsUnread,
  onBellClick,
  onSettingsClick,
  onToggleMobilePanel,
  activeMobilePanel,
  equity,
  currentBalance,
  unrealizedPnl,
  netDailyPnl,
  sodBalance,
  openSymbols,
  selectedSymbol,
  onSelectTab,
  onCloseTab,
  onAddTab,
  symbolList,
  getPrice,
}: {
  accountName: string;
  accountNumber: string;
  accounts: Array<{ id: string; name: string; providerAccountId?: string | null; status?: string }>;
  onSelect: (id: string) => void;
  marketConnected: boolean;
  connQuality: "good" | "weak" | "bad";
  latencyMs: number | null;
  alertsUnread: number;
  onBellClick: () => void;
  onSettingsClick: () => void;
  onToggleMobilePanel: (p: Panel) => void;
  activeMobilePanel: Panel | null;
  equity: number | null;
  currentBalance: number | null;
  unrealizedPnl: number | null;
  netDailyPnl: number | null;
  sodBalance: number | null;
  openSymbols: string[];
  selectedSymbol: string;
  onSelectTab: (sym: string) => void;
  onCloseTab: (sym: string) => void;
  onAddTab: (sym: string) => void;
  symbolList: Array<{ name: string; display: string; category: string }>;
  getPrice: (sym: string) => number | null;
}) {
  const fmtUsd = (v: number | null) =>
    v == null || !Number.isFinite(v)
      ? "—"
      : v.toLocaleString("en-US", { style: "currency", currency: "USD" });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <header className="flex items-center justify-between border-b border-white/10 bg-[#0d0f16] px-2 py-1 sm:px-4 sm:py-2 text-sm shrink-0">
      <div className="flex items-center gap-2 sm:gap-6 min-w-0">
        <div className="flex items-center gap-2 shrink-0">
          <img src="/apple-touch-icon.png" alt="Kai" className="h-6 w-6 sm:h-7 sm:w-7 rounded-lg" />
        </div>
        <div className="relative" ref={ref}>
          <button
            onClick={() => setOpen((v) => !v)}
            title={accountName}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-white/5 cursor-pointer min-w-0 transition-colors"
          >
            {/* Plano como los stats del header: solo el nº de cuenta + chevron.
                El nombre ("Sim 50K") vive en el dropdown para no recargar la barra. */}
            <div className="text-[13px] font-semibold truncate tabular-nums leading-tight">#{accountNumber}</div>
            <ChevronDown className="h-3.5 w-3.5 text-white/40 shrink-0" />
          </button>
          {open && accounts.length > 0 && (
            <div className="absolute top-full left-0 mt-1 w-64 max-w-[calc(100vw-2rem)] bg-[#0d0f16] border border-white/10 rounded-md shadow-xl z-50">
              <div className="max-h-80 overflow-y-auto">
                {accounts.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => {
                      setOpen(false);
                      onSelect(a.providerAccountId ?? a.id);
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-white/5 text-left"
                  >
                    <div className="min-w-0">
                      <div className="text-xs text-white/70 truncate">{a.name}</div>
                      <div className="text-[10px] text-white/40">#{a.providerAccountId ?? a.id}</div>
                    </div>
                    {a.status === "connected" && (
                      <span className="h-2 w-2 rounded-full bg-emerald-400 shrink-0 ml-2" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* En móvil las pestañas de símbolos se ocultan (los símbolos se cambian
          desde el bottom-nav "Símbolos"); así el header queda en una sola fila
          compacta. */}
      <div className="hidden md:flex min-w-0 flex-1">
        <MarketTabs
          openSymbols={openSymbols}
          selected={selectedSymbol}
          onSelect={onSelectTab}
          onClose={onCloseTab}
          onAdd={onAddTab}
          symbolList={symbolList}
          getPrice={getPrice}
        />
      </div>

      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <div className="hidden md:flex items-stretch gap-4 lg:gap-5 mr-2 pr-3 border-r border-white/8">
          {(() => {
            const StatBlock = ({ label, value, tone = "neutral" }: { label: string; value: number | null; tone?: "neutral" | "pnl" }) => {
              const missing = value == null || !Number.isFinite(value);
              const color =
                tone === "pnl" && !missing
                  ? (value as number) >= 0
                    ? "text-[#2ed68d]"
                    : "text-[#ef5350]"
                  : "text-white/90";
              return (
                <div className="flex flex-col justify-center min-w-0">
                  <div className="text-[10px] uppercase tracking-wide text-white/45 leading-tight whitespace-nowrap">{label}</div>
                  <div className={cn("font-semibold tabular-nums text-[13px] leading-tight whitespace-nowrap", color)}>{fmtUsd(value)}</div>
                </div>
              );
            };
            return (
              <>
                <StatBlock label="Current Balance" value={currentBalance} />
                <StatBlock label="Equity" value={equity} />
                <StatBlock label="Net Daily PnL" value={netDailyPnl} tone="pnl" />
                <StatBlock label="Unrealized PnL" value={unrealizedPnl} tone="pnl" />
                <StatBlock label="SOD Balance" value={sodBalance} />
              </>
            );
          })()}
        </div>
        <button
          onClick={onSettingsClick}
          className="flex items-center justify-center h-7 w-7 rounded-md text-white/60 hover:bg-white/5 hover:text-white"
          title="Configuración"
          aria-label="Configuración"
        >
          <Settings className="h-4 w-4" />
        </button>
        <button
          onClick={onBellClick}
          className="relative flex items-center justify-center h-7 w-7 rounded-md text-white/60 hover:bg-white/5 hover:text-white"
          title="Alertas de precio"
          aria-label="Alertas de precio"
        >
          <Bell className="h-4 w-4" />
          {alertsUnread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#ef5350] px-1 text-[9px] font-bold text-white tabular-nums">
              {alertsUnread > 9 ? "9+" : alertsUnread}
            </span>
          )}
        </button>
        {(() => {
          const cfg = {
            good: { color: "text-[#2ed68d]", title: "Buena conexión", desc: latencyMs != null ? `Conexión estable · ${latencyMs} ms` : "Conexión estable" },
            weak: { color: "text-[#e3b341]", title: "Conexión lenta", desc: `Tu conexión va lenta${latencyMs != null ? ` · ${latencyMs} ms` : ""}. Opera con precaución ⚠️` },
            bad: { color: "text-[#ef5350]", title: "Sin conexión estable", desc: "Tu internet falla. Ten precaución: las órdenes podrían no enviarse ⚠️" },
          }[connQuality];
          const Icon = connQuality === "bad" ? WifiOff : Wifi;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <button className={cn("flex items-center justify-center h-7 w-7 rounded-md hover:bg-white/5 transition-colors", cfg.color)} aria-label={cfg.title}>
                  <Icon className={cn("h-4 w-4", connQuality === "weak" && "animate-pulse")} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[220px] text-center">
                <p className="font-semibold">{cfg.title}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{cfg.desc}</p>
              </TooltipContent>
            </Tooltip>
          );
        })()}
      </div>
    </header>
  );
}

// Exness-style open-market tabs that live in the header. Each tab drives the
// chart + trade panel; "+" opens an instrument picker to add another market.
function MarketTabs({
  openSymbols,
  selected,
  onSelect,
  onClose,
  onAdd,
  symbolList,
  getPrice,
}: {
  openSymbols: string[];
  selected: string;
  onSelect: (sym: string) => void;
  onClose: (sym: string) => void;
  onAdd: (sym: string) => void;
  symbolList: Array<{ name: string; display: string; category: string }>;
  getPrice: (sym: string) => number | null;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? symbolList.filter(
          (s) => s.display.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
        )
      : symbolList;
    return base.slice(0, 60);
  }, [symbolList, query]);

  const fmtPrice = (sym: string): string => {
    const p = getPrice(sym);
    if (p == null) return "—";
    const dec = p >= 100 ? 2 : p >= 1 ? 4 : 5;
    return p.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  };

  return (
    <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto px-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
      {openSymbols.map((sym) => {
        const ic = symbolIcon(sym);
        const active = sym === selected;
        return (
          <div
            key={sym}
            onClick={() => onSelect(sym)}
            className={cn(
              "group flex items-center gap-2 pl-2 pr-1.5 py-1 rounded-lg border cursor-pointer shrink-0 transition-colors",
              active
                ? "border-[#2f6bff]/50 bg-[#2f6bff]/10"
                : "border-transparent hover:bg-white/5",
            )}
          >
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0"
              style={{ background: ic.bg, color: ic.fg }}
            >
              {ic.glyph}
            </span>
            <div className="flex flex-col leading-none min-w-0">
              <span className="text-[12px] font-semibold truncate max-w-[90px]">
                {formatSymbolDisplay(sym)}
              </span>
              <span className="text-[10px] text-white/45 tabular-nums">{fmtPrice(sym)}</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onClose(sym);
              }}
              className="flex h-4 w-4 items-center justify-center rounded text-white/30 hover:text-white hover:bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
              aria-label={`Cerrar ${formatSymbolDisplay(sym)}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}

      <div className="relative shrink-0" ref={ref}>
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-white/50 hover:bg-white/5 hover:text-white transition-colors"
          aria-label="Agregar mercado"
          title="Agregar mercado"
        >
          <Plus className="h-4 w-4" />
        </button>
        {pickerOpen && (
          <div className="absolute top-full left-0 mt-1 w-72 max-w-[calc(100vw-2rem)] bg-[#0d0f16] border border-white/10 rounded-lg shadow-xl z-50 overflow-hidden">
            <div className="p-2 border-b border-white/10">
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-[#151824]">
                <Search className="h-3.5 w-3.5 text-white/40 shrink-0" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar instrumento..."
                  className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-white/30"
                />
              </div>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {results.length === 0 && (
                <div className="px-3 py-4 text-center text-[12px] text-white/40">Sin resultados</div>
              )}
              {results.map((s) => {
                const ic = symbolIcon(s.name);
                const isOpen = openSymbols.includes(s.name);
                return (
                  <button
                    key={s.name}
                    onClick={() => {
                      onAdd(s.name);
                      setPickerOpen(false);
                      setQuery("");
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/5 text-left"
                  >
                    <span
                      className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold shrink-0"
                      style={{ background: ic.bg, color: ic.fg }}
                    >
                      {ic.glyph}
                    </span>
                    <span className="text-[13px] font-medium flex-1 truncate">{s.display}</span>
                    {isOpen && <span className="text-[10px] text-[#2f6bff]">Abierto</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Watchlist({
  items,
  ticks,
  dbAccountId,
  loading,
  selected,
  onSelect,
  categoryFilter,
  onCategoryChange,
}: {
  items: Array<{ name: string; display: string; category: string }>;
  ticks: ReadonlyMap<string, { bid: number; ask: number; last: number }>;
  dbAccountId: string | null;
  loading: boolean;
  selected: string;
  onSelect: (sym: string) => void;
  categoryFilter: string;
  onCategoryChange: (c: string) => void;
}) {
  const categories = useMemo(() => {
    const set = new Set(items.map((i) => i.category));
    return ["TODO", ...Array.from(set)];
  }, [items]);
  const [search, setSearch] = useState("");
  const filtered = items.filter(
    (i) =>
      (categoryFilter === "TODO" || i.category === categoryFilter) &&
      (i.display.toLowerCase().includes(search.toLowerCase()) || i.name.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <>
      <div className="px-3 py-3 border-b border-white/10">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-white/70">Watchlist</span>
          <Plus className="h-3.5 w-3.5 text-white/50 hover:text-white cursor-pointer" />
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-white/40" />
          <Input
            placeholder="Buscar instrumentos..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-7 pl-7 text-xs bg-white/5 border-white/10 text-white placeholder:text-white/40"
          />
        </div>
      </div>
      <div className="flex gap-2 px-2 py-2 border-b border-white/10 text-[10px] overflow-x-auto">
        {categories.map((c) => (
          <button
            key={c}
            onClick={() => onCategoryChange(c)}
            className={cn(
              "px-2 py-1 rounded font-medium transition-colors whitespace-nowrap",
              categoryFilter === c ? "text-white border-b border-[#2f6bff]" : "text-white/50 hover:text-white/80",
            )}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-[22px_1fr_auto] items-center gap-2.5 px-4 py-1.5 text-[10px] uppercase tracking-wider text-white/40 border-b border-white/10">
        <div></div>
        <div>Par</div>
        <div className="text-right">Precio</div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-6 text-white/50">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-6 px-3 text-center">
            <p className="text-xs text-white/50">Sin símbolos disponibles</p>
            {items.length === 0 && (
              <p className="text-[10px] text-white/30 mt-1">Conecta una cuenta para ver los instrumentos</p>
            )}
          </div>
        )}
        {filtered.map((item) => {
          const tick = dbAccountId ? ticks.get(`${dbAccountId}::${item.name}`) : null;
          const isSel = selected === item.name;
          const icon = symbolIcon(item.name);
          return (
            <div
              key={item.name}
              onClick={() => onSelect(item.name)}
              className={cn(
                "grid grid-cols-[22px_1fr_auto] items-center gap-2.5 px-4 py-2 text-xs cursor-pointer transition-colors",
                isSel ? "bg-[#2f6bff]/[0.08] shadow-[inset_2px_0_0_#2f6bff]" : "hover:bg-[#151824]",
              )}
            >
              <div
                className="flex h-[22px] w-[22px] items-center justify-center rounded-full text-[9px] font-bold"
                style={{ background: icon.bg, color: icon.fg }}
              >
                {icon.glyph}
              </div>
              <div className={cn("font-medium truncate", isSel ? "text-white" : "text-[#dde2ea]")}>{item.display}</div>
              <div className="text-right text-[#cdd3dd] tabular-nums">
                {tick ? tick.bid.toFixed(tick.bid < 10 ? 5 : 2) : "—"}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function CloseAllDialog({
  open,
  onOpenChange,
  positions,
  busy,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  positions: CopyTradingPosition[];
  busy: boolean;
  onConfirm: (list: CopyTradingPosition[]) => void | Promise<void>;
}) {
  const sum = (list: CopyTradingPosition[]) => list.reduce((a, p) => a + (p.openPnlUsd ?? 0), 0);
  const options = useMemo(() => {
    const profit = positions.filter((p) => (p.openPnlUsd ?? 0) > 0);
    const losing = positions.filter((p) => (p.openPnlUsd ?? 0) < 0);
    const buys = positions.filter((p) => p.side === "LONG");
    const sells = positions.filter((p) => p.side === "SHORT");
    return [
      { id: "all", label: "Cerrar todas", list: positions },
      { id: "profit", label: "Cerrar todas las rentables", list: profit },
      { id: "losing", label: "Cerrar todas las perdedoras", list: losing },
      { id: "buy", label: "Cerrar todas las de compra", list: buys },
      { id: "sell", label: "Cerrar todas las de venta", list: sells },
    ];
  }, [positions]);
  const [choice, setChoice] = useState("all");
  const selected = options.find((o) => o.id === choice) ?? options[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-white/10 bg-[#0d0f16] text-white">
        <DialogHeader>
          <DialogTitle>¿Cerrar posiciones a precio de mercado?</DialogTitle>
          <DialogDescription className="sr-only">
            Elige qué grupo de posiciones cerrar y confirma la operación.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          {options.map((o) => {
            const total = sum(o.list);
            const disabled = o.list.length === 0;
            const active = choice === o.id;
            return (
              <button
                key={o.id}
                disabled={disabled}
                onClick={() => setChoice(o.id)}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors",
                  active ? "border-[#2f6bff] bg-[#2f6bff]/10" : "border-white/10 hover:bg-white/5",
                  disabled && "opacity-40 cursor-not-allowed",
                )}
              >
                <span className="flex items-center gap-2 text-[13px]">
                  <span className={cn("flex h-3.5 w-3.5 items-center justify-center rounded-full border", active ? "border-[#2f6bff]" : "border-white/30")}>
                    {active && <span className="h-1.5 w-1.5 rounded-full bg-[#2f6bff]" />}
                  </span>
                  {o.label}
                  <span className="text-white/40">({o.list.length})</span>
                </span>
                <span className={cn("text-[13px] tabular-nums font-medium", total >= 0 ? "text-[#2ed68d]" : "text-[#ef5350]")}>
                  {total >= 0 ? "+" : ""}${total.toFixed(2)}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex gap-2 pt-2">
          <Button variant="outline" className="flex-1 border-white/10 bg-transparent" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button
            className="flex-1 bg-[#1aa86a] hover:bg-[#1fbd78] text-white"
            disabled={busy || !selected || selected.list.length === 0}
            onClick={() => void onConfirm(selected.list)}
          >
            {busy ? "Cerrando…" : "Confirmar"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const ORDER_KIND_LABEL: Record<TradingOrder["type"], string> = {
  limit: "LIMIT",
  stop: "STOP",
  stop_limit: "STOP LIMIT",
  other: "—",
};

// ── Columna ID de trades (ticket del broker) ─────────────────────────────────
// OCULTA por default; el "ojito" la muestra a elección del usuario y persiste
// en localStorage — mismo comportamiento que la columna ID de Orders en el
// frontend principal (para el futuro sistema de reportes de trades).
const SHOW_TRADE_IDS_KEY = "kai:terminal:show-trade-ids";

function useShowTradeIds(): [boolean, () => void] {
  const [show, setShow] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(SHOW_TRADE_IDS_KEY) === "1";
  });
  const toggle = useCallback(() => {
    setShow((v) => {
      const next = !v;
      try {
        localStorage.setItem(SHOW_TRADE_IDS_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return [show, toggle];
}

function TradeIdsToggle({ show, onToggle }: { show: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={show ? "Ocultar IDs de trades" : "Mostrar IDs de trades"}
      aria-label={show ? "Ocultar IDs de trades" : "Mostrar IDs de trades"}
      className={cn(
        "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded border transition-colors",
        show
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
          : "border-white/10 text-white/40 hover:text-white/70",
      )}
    >
      {show ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
    </button>
  );
}

// Prefijo "[Emulada]" en nombres de cuenta se abrevia "[Sim]" (igual que
// formatConnectionAccount en Orders del frontend principal).
const displayAccountName = (name: string) => name.replace(/^\[Emulada\]/, "[Sim]");

// Contenido de la pestaña ÓRDENES: órdenes PENDIENTES (working orders reales del
// broker) arriba, y las EJECUTADAS (historial de trades cerrados) abajo —
// reemplaza a la vieja pestaña HISTORIAL (las abiertas viven en POSICIONES).
function OrdersTabContent({
  orders,
  historyTrades,
  onFocusTrade,
  accountName,
  showTradeIds,
  onToggleTradeIds,
}: {
  orders: TradingOrder[];
  historyTrades: TradingHistoryItem[];
  onFocusTrade?: (t: TradingHistoryItem) => void;
  /** Nombre de la cuenta activa (el historial es siempre de UNA cuenta). */
  accountName: string;
  /** Columna ID (tickets) visible — controlada por el "ojito" (persistida). */
  showTradeIds: boolean;
  onToggleTradeIds: () => void;
}) {
  // Filas de EJECUTADAS expandidas para ver las salidas parciales (scale-out).
  // Click en el nº de contratos de un trade con >1 tramo la despliega.
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  const toggleRow = (id: string) =>
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Numéricos sin valor se muestran como 0.00 (no "—"): convención MT5 donde
  // SL/TP = 0 significa "sin nivel".
  const num = (n: number | null | undefined, dp = 2) =>
    (n == null || !Number.isFinite(n) ? 0 : n).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const time = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("es-DO", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
  const sectionHead = "sticky top-0 z-10 bg-[#0b1420] px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-white/45";
  const th = "px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide text-white/40";

  // Cierre MANUAL (badge "M" igual que la vista Orders del frontend principal):
  // KAI_META closeSource manual_kai/manual_mt5, o DEAL_REASON CLIENT/MOBILE/WEB.
  const manualCloseTooltip = (t: TradingHistoryItem): string | null => {
    if (t.closeSource === "manual_kai") return "Cierre manual desde Kai";
    if (t.closeSource === "manual_mt5") return "Cierre manual desde MT5";
    const reason = String(t.closeReason || "").trim().toUpperCase().replace(/^DEAL_REASON_/, "");
    if (["CLIENT", "MOBILE", "WEB"].includes(reason)) return "Cierre manual desde MT5";
    return null;
  };

  return (
    <div className="flex-1 overflow-auto" style={{ scrollbarWidth: "thin" }}>
      {/* Órdenes PENDIENTES (working orders del broker). Cuentas sim/a-mercado
          nunca las tienen, así que la sección se oculta si está vacía en vez de
          mostrar un "Sin órdenes pendientes" permanente. */}
      {orders.length > 0 && (
        <>
          <div className={sectionHead}>Pendientes</div>
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left">
                <th className={th + " text-left"}>Símbolo</th>
                <th className={th + " text-left"}>Lado</th>
                <th className={th + " text-left"}>Tipo</th>
                <th className={th + " text-right"}>Contratos</th>
                <th className={th + " text-right"}>Precio</th>
                <th className={th + " text-right"}>SL</th>
                <th className={th + " text-right"}>TP</th>
                <th className={th + " text-right"}>Colocada</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-white/5 text-white/80">
                  <td className="px-3 py-1.5 font-medium text-white">{formatSymbolDisplay(o.symbol)}</td>
                  <td className={`px-3 py-1.5 ${o.side === "buy" ? "text-[#4ac767]" : "text-[#f0705c]"}`}>{o.side === "buy" ? "BUY" : "SELL"}</td>
                  <td className="px-3 py-1.5">{ORDER_KIND_LABEL[o.type]}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{num(o.volume)}</td>
                  <td className="px-3 py-1.5 text-right font-mono">{num(o.price)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#f0705c]">{num(o.stopLoss)}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-[#4ac767]">{num(o.takeProfit)}</td>
                  <td className="px-3 py-1.5 text-right text-white/50">{time(o.placedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className={cn(sectionHead, "flex items-center justify-between", orders.length > 0 && "border-t border-white/10")}>
        <span>Ejecutadas</span>
        <TradeIdsToggle show={showTradeIds} onToggle={onToggleTradeIds} />
      </div>
      {historyTrades.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-white/40">Sin ejecutadas recientes</div>
      ) : (
        // Mismas columnas que la vista Orders del frontend principal:
        // Cuenta | Contrato | Dirección | Contratos | Entrada | Salida | TP | SL | PnL | Tipo | Hora.
        // La tabla es más ancha que el panel inferior → scroll horizontal propio.
        <div className="overflow-x-auto" style={{ scrollbarWidth: "thin" }}>
          <table className={cn("w-full text-[11px]", showTradeIds ? "min-w-[1020px]" : "min-w-[960px]")}>
            <thead>
              <tr className="text-left">
                {showTradeIds && <th className={th + " text-left"}>ID</th>}
                <th className={th + " text-left"}>Cuenta</th>
                <th className={th + " text-left"}>Contrato</th>
                <th className={th + " text-left"}>Dirección</th>
                <th className={th + " text-right"}>Contratos</th>
                <th className={th + " text-right"}>Entrada</th>
                <th className={th + " text-right"}>Salida</th>
                <th className={th + " text-right"}>TP</th>
                <th className={th + " text-right"}>SL</th>
                <th className={th + " text-right"}>PnL</th>
                <th className={th + " text-left"}>Tipo</th>
                <th className={th + " text-right"}>Hora</th>
              </tr>
            </thead>
            <tbody>
              {historyTrades.map((t) => {
                const manualTooltip = manualCloseTooltip(t);
                const hasPartials = !!(t.partials && t.partials.length > 1);
                const expanded = expandedRows.has(t.id);
                const colCount = showTradeIds ? 12 : 11;
                return (
                  <Fragment key={t.id}>
                  <tr
                    onDoubleClick={() => onFocusTrade?.(t)}
                    title="Doble clic para ver este trade en el chart"
                    className="border-t border-white/5 text-white/80 cursor-pointer hover:bg-white/5"
                  >
                    {/* Ticket del broker (referencia para reportes de trades);
                        fallback id corto si el API aún no manda ticket. */}
                    {showTradeIds && (
                      <td className="px-3 py-1.5 font-mono text-[10px] text-white/50 whitespace-nowrap" title={t.id}>
                        #{t.ticket ?? t.id.slice(0, 8)}
                      </td>
                    )}
                    <td className="px-3 py-1.5 text-white/70 whitespace-nowrap">{displayAccountName(accountName)}</td>
                    <td className="px-3 py-1.5 font-medium text-white">{formatSymbolDisplay(t.symbol)}</td>
                    <td className={`px-3 py-1.5 ${t.side === "buy" ? "text-[#4ac767]" : "text-[#f0705c]"}`}>{t.side === "buy" ? "BUY" : "SELL"}</td>
                    <td className="px-3 py-1.5 text-right font-mono">
                      {hasPartials ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleRow(t.id);
                          }}
                          title={`${t.partials!.length} salidas parciales — clic para ${expanded ? "ocultar" : "ver"}`}
                          className="inline-flex items-center gap-1 rounded px-1 text-white hover:bg-white/10"
                        >
                          {num(t.volume)}
                          <span className="text-[9px] text-white/50">{expanded ? "▴" : "▾"}</span>
                        </button>
                      ) : (
                        num(t.volume)
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono">{num(t.entryPrice)}</td>
                    <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">
                      {num(t.exitPrice)}
                      {manualTooltip && (
                        <span
                          title={manualTooltip}
                          className="ml-1 inline-flex items-center rounded bg-white/10 px-1 text-[9px] font-bold leading-4 text-white/60 align-middle"
                        >
                          M
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-[#4ac767]">{num(t.takeProfit)}</td>
                    <td className="px-3 py-1.5 text-right font-mono text-[#f0705c]">{num(t.stopLoss)}</td>
                    <td className={`px-3 py-1.5 text-right font-mono ${(t.profitLoss ?? 0) >= 0 ? "text-[#4ac767]" : "text-[#f0705c]"}`}>
                      {`${(t.profitLoss ?? 0) >= 0 ? "+" : ""}$${num(t.profitLoss)}`}
                    </td>
                    {/* synced_trades no guarda el tipo de orden; la vista Orders del
                        frontend principal también lo fija a "Mercado". */}
                    <td className="px-3 py-1.5 text-white/60">Mercado</td>
                    <td className="px-3 py-1.5 text-right text-white/50 whitespace-nowrap">
                      <div className="flex flex-col items-end leading-tight">
                        <span>
                          <span className="mr-1 text-[9px] font-bold uppercase text-white/30">Ent</span>
                          {time(t.openedAt)}
                        </span>
                        <span>
                          <span className="mr-1 text-[9px] font-bold uppercase text-white/30">Sal</span>
                          {time(t.closedAt)}
                        </span>
                      </div>
                    </td>
                  </tr>
                  {hasPartials && expanded && (
                    <tr className="bg-black/20">
                      <td colSpan={colCount} className="px-3 py-2">
                        <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-white/40">
                          Salidas parciales · {t.partials!.length} tramos
                        </div>
                        <div className="flex flex-col gap-0.5">
                          {t.partials!.map((p, i) => (
                            <div
                              key={i}
                              className="flex items-center gap-4 font-mono text-[11px] text-white/70"
                            >
                              <span className="w-12 text-white/40">{num(p.qty)} ct</span>
                              <span>@ {num(p.price)}</span>
                              <span
                                className={
                                  (p.pnl ?? 0) >= 0 ? "text-[#4ac767]" : "text-[#f0705c]"
                                }
                              >
                                {`${(p.pnl ?? 0) >= 0 ? "+" : ""}$${num(p.pnl)}`}
                              </span>
                              <span className="text-white/40">{time(p.at)}</span>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function BottomPanel({
  positions,
  loading,
  activeTab,
  accounts,
  totalPnl,
  balance,
  equity,
  marginFree,
  onClose,
  onUpdateStops,
  orders,
  historyTrades,
  onFocusTrade,
  onFocusPosition,
  unitLabel,
  accountName,
}: {
  positions: CopyTradingPosition[];
  loading: boolean;
  activeTab: BottomTab;
  accounts: Array<{ id: string; name: string; providerAccountId?: string | null; status?: string; accountType?: string | null; balance?: number | null; equity?: number | null }>;
  totalPnl: number;
  balance: number | null;
  equity: number | null;
  marginFree: number | null;
  onClose: (p: CopyTradingPosition) => void;
  onUpdateStops: (p: CopyTradingPosition, sl: number | null, tp: number | null) => Promise<void>;
  orders: TradingOrder[];
  historyTrades: TradingHistoryItem[];
  onFocusTrade?: (t: TradingHistoryItem) => void;
  onFocusPosition?: (p: CopyTradingPosition) => void;
  unitLabel: string;
  /** Nombre de la cuenta activa — columna "Cuenta" de EJECUTADAS. */
  accountName: string;
}) {
  // Futuros → "Contratos" (enteros); CFD → "Lotes" (2 decimales). El label y el
  // formato de la columna de cantidad siguen el modo del terminal.
  const isContracts = unitLabel === "Contratos";
  // Columna ID (tickets) oculta por default; el "ojito" la muestra y persiste.
  // Compartida entre POSICIONES y EJECUTADAS (mismo estado/misma key).
  const [showTradeIds, toggleTradeIds] = useShowTradeIds();
  const [edit, setEdit] = useState<CopyTradingPosition | null>(null);
  const [editSl, setEditSl] = useState("");
  const [editTp, setEditTp] = useState("");
  const [saving, setSaving] = useState(false);
  const px = (v: number | null | undefined) =>
    v == null ? "—" : v.toFixed(v > 0 && v < 20 ? 5 : 2);

  const openEdit = (p: CopyTradingPosition) => {
    setEdit(p);
    // Pre-llenado por DEFECTO con RR 1:3 cuando la posición no trae SL/TP (antes
    // salía "0 = sin TP/SL", confuso). Riesgo ≈ 0.2% del precio de entrada, reward
    // 3× (1:3). El usuario ajusta antes de confirmar. Si ya hay SL/TP, se respetan.
    const entry = p.avgPrice || p.currentPrice || 0;
    const isLong = p.side === "LONG";
    const risk = entry * 0.002;
    const round = (v: number) => Number(v.toFixed(entry > 0 && entry < 20 ? 5 : 2));
    const defSl =
      p.sl && p.sl > 0
        ? p.sl
        : entry > 0
          ? round(isLong ? entry - risk : entry + risk)
          : 0;
    const defTp =
      p.tp && p.tp > 0
        ? p.tp
        : entry > 0
          ? round(isLong ? entry + 3 * risk : entry - 3 * risk)
          : 0;
    setEditSl(defSl > 0 ? String(defSl) : "");
    setEditTp(defTp > 0 ? String(defTp) : "");
  };
  const saveEdit = async () => {
    if (!edit) return;
    setSaving(true);
    try {
      await onUpdateStops(edit, parseFloat(editSl) || null, parseFloat(editTp) || null);
      setEdit(null);
    } finally {
      setSaving(false);
    }
  };

  // Variante sin la columna ID (oculta por default, toggle "ojito").
  const COLS = showTradeIds
    ? "grid-cols-[80px_104px_52px_64px_1fr_1fr_84px_84px_120px_1fr_30px]"
    : "grid-cols-[104px_52px_64px_1fr_1fr_84px_84px_120px_1fr_30px]";
  const fmtOpened = (iso: string | null) =>
    iso ? new Date(iso).toLocaleString("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

  const fmtAcctUsd = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD" });
  const ACCT_COLS = "grid-cols-[minmax(140px,1.4fr)_90px_minmax(90px,1fr)_120px_120px]";

  return (
    <>
      {activeTab === "CUENTAS" && (
        <div className="flex-1 overflow-y-auto">
          {accounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-6 text-white/50 text-xs">
              <p>Sin cuentas</p>
            </div>
          ) : (
            <>
              <div className={cn("hidden sm:grid gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-white/40 border-b border-white/5", ACCT_COLS)}>
                <div>Account Name</div>
                <div>Status</div>
                <div>Account Type</div>
                <div className="text-right">Balance</div>
                <div className="text-right">Current Balance</div>
              </div>
              {accounts.map((a) => {
                const connected = a.status === "connected";
                return (
                  <div key={a.id} className="px-3 py-2 text-xs hover:bg-white/5 border-b border-white/5">
                    <div className={cn("hidden sm:grid gap-2 items-center", ACCT_COLS)}>
                      <div className="font-semibold text-white truncate">{a.name}</div>
                      <div className="flex items-center gap-1.5">
                        <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", connected ? "bg-[#2ed68d]" : "bg-white/30")} />
                        <span className="text-white/70">{connected ? "Active" : a.status ?? "—"}</span>
                      </div>
                      <div className="text-white/70 truncate">{a.accountType ?? "—"}</div>
                      <div className="text-right text-white/80 tabular-nums">{fmtAcctUsd(a.balance)}</div>
                      <div className="text-right text-white/80 tabular-nums">{fmtAcctUsd(a.equity ?? a.balance)}</div>
                    </div>
                    {/* Mobile */}
                    <div className="sm:hidden flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="font-semibold text-white truncate">{a.name}</div>
                        <div className="text-[10px] text-white/50">{a.accountType ?? "—"} · {connected ? "Active" : a.status ?? "—"}</div>
                      </div>
                      <div className="text-right tabular-nums text-white/80">{fmtAcctUsd(a.equity ?? a.balance)}</div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}

      {activeTab === "POSICIONES" && (
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-6 text-white/50">
              <Loader2 className="h-4 w-4 animate-spin" />
            </div>
          )}
          {!loading && positions.length === 0 && (
            <div className="flex flex-col items-center justify-center py-6 text-white/50 text-xs">
              <p>Sin posiciones abiertas</p>
              <p className="text-[10px] text-white/30 mt-1">Las posiciones abiertas aparecerán aquí</p>
            </div>
          )}
          {!loading && positions.length > 0 && (
            <>
              <div className={cn("hidden sm:grid gap-2 px-3 py-1.5 text-[10px] uppercase tracking-wider text-white/40 border-b border-white/5", COLS)}>
                {showTradeIds && <div>ID</div>}
                <div>Símbolo</div>
                <div>Tipo</div>
                <div className="text-right">{unitLabel}</div>
                <div className="text-right">Entrada</div>
                <div className="text-right">Actual</div>
                <div className="text-right">TP</div>
                <div className="text-right">SL</div>
                <div className="text-right">Hora apertura</div>
                <div className="text-right">P&L</div>
                {/* Esquina de acciones: toggle "ojito" de la columna ID. */}
                <div className="flex justify-end">
                  <TradeIdsToggle show={showTradeIds} onToggle={toggleTradeIds} />
                </div>
              </div>
              {positions.map((p) => (
                <div
                  key={p.id}
                  onDoubleClick={() => onFocusPosition?.(p)}
                  title="Doble clic para ver esta posición en el chart"
                  className="px-3 py-2 text-xs hover:bg-white/5 border-b border-white/5 cursor-pointer"
                >
                  {/* Mobile */}
                  <div className="grid grid-cols-2 sm:hidden gap-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-white">{formatSymbolDisplay(p.symbol)}</span>
                      <Badge className={cn("px-1.5 py-0 text-[10px] font-bold border-0", p.side === "LONG" ? "bg-[#2ed68d]/15 text-[#2ed68d]" : "bg-[#ef5350]/15 text-[#ef5350]")}>
                        {p.side === "LONG" ? "BUY" : "SELL"}
                      </Badge>
                    </div>
                    <div className="text-right">
                      <span className={cn("font-bold", p.openPnlUsd >= 0 ? "text-[#2ed68d]" : "text-[#ef5350]")}>
                        {p.openPnlUsd >= 0 ? "+" : ""}${p.openPnlUsd.toFixed(2)}
                      </span>
                    </div>
                    <div className="text-white/60 text-[10px]">#{p.id} · {p.qty} @ {px(p.avgPrice)}</div>
                    <div className="flex justify-end gap-2">
                      <button onClick={() => openEdit(p)} className="h-6 text-[10px] text-[#2f6bff] hover:underline px-1">SL/TP</button>
                      <button onClick={() => onClose(p)} className="h-6 text-[10px] text-[#ef5350] hover:underline px-1">CERRAR</button>
                    </div>
                  </div>
                  {/* Desktop */}
                  <div className={cn("hidden sm:grid gap-2 items-center", COLS)}>
                    {/* Ticket del broker — mismo look que la columna ID de EJECUTADAS. */}
                    {showTradeIds && (
                      <div className="font-mono text-[10px] text-white/50 truncate" title={p.id}>#{p.id}</div>
                    )}
                    <div className="font-semibold text-white truncate">{formatSymbolDisplay(p.symbol)}</div>
                    <div>
                      <Badge className={cn("px-2 py-0.5 text-[10px] font-bold border-0", p.side === "LONG" ? "bg-[#2ed68d]/15 text-[#2ed68d]" : "bg-[#ef5350]/15 text-[#ef5350]")}>
                        {p.side === "LONG" ? "BUY" : "SELL"}
                      </Badge>
                    </div>
                    <div className="text-right text-white/80 tabular-nums">{isContracts ? p.qty.toFixed(0) : p.qty.toFixed(2)}</div>
                    <div className="text-right text-white/80 tabular-nums">{px(p.avgPrice)}</div>
                    <div className={cn("text-right font-semibold tabular-nums", p.currentPrice >= p.avgPrice ? "text-[#2ed68d]" : "text-[#ef5350]")}>
                      {px(p.currentPrice)}
                    </div>
                    <button onClick={() => openEdit(p)} title="Modificar TP" className="text-right text-[#2ed68d] tabular-nums hover:underline">{p.tp ? px(p.tp) : "+ TP"}</button>
                    <button onClick={() => openEdit(p)} title="Modificar SL" className="text-right text-[#ef5350] tabular-nums hover:underline">{p.sl ? px(p.sl) : "+ SL"}</button>
                    <div className="text-right text-white/55 tabular-nums text-[11px]">{fmtOpened(p.openedAtIso)}</div>
                    <div className={cn("text-right font-bold tabular-nums", p.openPnlUsd >= 0 ? "text-[#2ed68d]" : "text-[#ef5350]")}>
                      {p.openPnlUsd >= 0 ? "+" : ""}${p.openPnlUsd.toFixed(2)}
                    </div>
                    <button
                      onClick={() => onClose(p)}
                      title="Cerrar posición"
                      className="flex h-6 w-6 items-center justify-center rounded text-white/40 hover:bg-[#ef5350]/15 hover:text-[#ef5350] justify-self-end"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-1 px-3 py-2.5 border-t border-white/10 text-[11px]">
                <div className="flex items-center gap-2 text-white/50">
                  <span className="uppercase tracking-wider text-[10px]">Saldo</span>
                  <span className="font-semibold text-white tabular-nums">
                    {balance == null ? "—" : balance.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-white/50">
                  <span className="uppercase tracking-wider text-[10px]">Capital</span>
                  <span className="font-semibold text-white tabular-nums">
                    {equity == null ? "—" : equity.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-white/50">
                  <span className="uppercase tracking-wider text-[10px]">Margen Libre</span>
                  <span className="font-semibold text-white tabular-nums">
                    {marginFree == null ? "—" : marginFree.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                  </span>
                </div>
                <div className="flex items-center gap-2 ml-auto">
                  <span className="text-white/50 uppercase tracking-wider text-[10px]">P&L Total</span>
                  <span className={cn("font-semibold tabular-nums text-[13px]", totalPnl >= 0 ? "text-[#2ed68d]" : "text-[#ef5350]")}>
                    {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <Dialog open={Boolean(edit)} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-sm border-white/10 bg-[#0d0f16] text-white">
          <DialogHeader>
            <DialogTitle>Modificar SL / TP · #{edit?.id}</DialogTitle>
            <DialogDescription className="sr-only">
              Edita el Stop Loss y el Take Profit de la posición.
            </DialogDescription>
          </DialogHeader>
          {edit && (
            <div className="space-y-3">
              <div className="text-[11px] text-white/50">
                {formatSymbolDisplay(edit.symbol)} · {edit.side === "LONG" ? "BUY" : "SELL"} · entrada {px(edit.avgPrice)}
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#2ed68d] mb-1">Take Profit</div>
                <Input value={editTp} onChange={(e) => setEditTp(e.target.value)} placeholder="Take profit" className="h-9 bg-[#151824] border-white/10 text-white tabular-nums" />
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-[#ef5350] mb-1">Stop Loss</div>
                <Input value={editSl} onChange={(e) => setEditSl(e.target.value)} placeholder="Stop loss" className="h-9 bg-[#151824] border-white/10 text-white tabular-nums" />
              </div>
              <div className="flex gap-2 pt-1">
                <Button variant="outline" className="flex-1 border-white/10 bg-transparent" onClick={() => setEdit(null)}>Cancelar</Button>
                <Button className="flex-1 bg-[#2f6bff] hover:bg-[#3a64b8] text-white" disabled={saving} onClick={() => void saveEdit()}>
                  {saving ? "Guardando…" : "Confirmar"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {activeTab === "ORDENES" && (
        <OrdersTabContent
          orders={orders}
          historyTrades={historyTrades}
          onFocusTrade={onFocusTrade}
          accountName={accountName}
          showTradeIds={showTradeIds}
          onToggleTradeIds={toggleTradeIds}
        />
      )}
    </>
  );
}

function TradePanel({
  bidPrice,
  askPrice,
  spread,
  symbol,
  orderType,
  setOrderType,
  volume,
  setVolume,
  takeProfitEnabled,
  setTakeProfitEnabled,
  takeProfitPrice,
  setTakeProfitPrice,
  stopLossEnabled,
  setStopLossEnabled,
  stopLossPrice,
  setStopLossPrice,
  notional,
  risk,
  reward,
  onSubmit,
  submitting,
  lastPrice,
  orderMode,
  setOrderMode,
  capital,
  autoTpSl,
  strategy,
  tickSpec,
  maxContracts,
  activePosition,
  onClosePosition,
  onReverse,
  onFlattenAll,
  onCancelAll,
}: {
  bidPrice: number;
  askPrice: number;
  spread: number;
  symbol: string;
  orderType: OrderType;
  setOrderType: (t: OrderType) => void;
  volume: string;
  setVolume: (v: string) => void;
  takeProfitEnabled: boolean;
  setTakeProfitEnabled: (b: boolean) => void;
  takeProfitPrice: string;
  setTakeProfitPrice: (v: string) => void;
  stopLossEnabled: boolean;
  setStopLossEnabled: (b: boolean) => void;
  stopLossPrice: string;
  setStopLossPrice: (v: string) => void;
  notional: number;
  risk: number;
  reward: number;
  onSubmit: (side: "buy" | "sell") => void;
  submitting: boolean;
  lastPrice: number;
  orderMode: OrderMode;
  setOrderMode: (m: OrderMode) => void;
  capital: number | null;
  autoTpSl: boolean;
  strategy: TerminalStrategy;
  tickSpec: FuturesTickSpec | null;
  maxContracts: number | null;
  activePosition?: CopyTradingPosition | null;
  onClosePosition?: () => void;
  onReverse?: () => void;
  onFlattenAll?: () => void;
  onCancelAll?: () => void;
}) {
  const ratio = reward > 0 && risk > 0 ? `1 : ${(reward / risk).toFixed(2)}` : "—";
  const hasData = bidPrice > 0;
  // Precio de disparo para LIMIT/STOP (UI). La ejecución real de pendientes se
  // cablea aparte (execution-api → bridge MT5, que ya soporta buy_limit/sell_stop).
  const [orderPrice, setOrderPrice] = useState<string>("");
  const isPending = orderType !== "MERCADO";
  const orderTypeLabel = orderType === "LIMITE" ? "LIMIT" : orderType === "STOP" ? "STOP" : "MARKET";
  const isOneClick = orderMode === "oneClick";
  const isRisk = orderMode === "risk";
  const isFutures = strategy.mode === "futures";
  const ordersEnabled = strategy.ordersEnabled;
  // Risk-calc mode: user picks a % of capital to risk + an SL price; we derive
  // the lot size from the same model the risk readout uses (risk = |price−SL| ×
  // lots), so the displayed Riesgo stays consistent. Setting the volume feeds
  // the rest of the normal submit flow.
  const [riskPct, setRiskPct] = useState<string>("1");
  // AlphaTrader futures ticket: OCO/Bracket toggle drives the shared TP/SL
  // enablement flags so the existing place-order flow attaches the bracket.
  const [bracketOn, setBracketOn] = useState<boolean>(false);
  const slDist = isRisk && parseFloat(stopLossPrice) > 0 ? Math.abs(lastPrice - parseFloat(stopLossPrice)) : 0;
  const riskUsd = capital != null && parseFloat(riskPct) > 0 ? capital * (parseFloat(riskPct) / 100) : 0;
  // Mode-aware sizing: CFD reproduces the naive `riskUsd/slDist` lots exactly;
  // futures returns integer contracts via `floor(riskUsd/(slTicks×tickValue))`,
  // then clamps to the Apex maxContracts cap when it is known.
  const rawComputedSize = slDist > 0 && riskUsd > 0 ? strategy.computeSize(riskUsd, slDist, tickSpec) : 0;
  const computedSize = isFutures ? clampToMaxContracts(rawComputedSize, maxContracts) : rawComputedSize;
  // Estimated USD risk for the (integer, capped) futures size shown in preview.
  const estRisk = isFutures ? estimateFuturesRisk(computedSize, slDist, tickSpec) : riskUsd;
  useEffect(() => {
    if (isRisk && computedSize > 0) setVolume(strategy.formatVolume(computedSize));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRisk, computedSize]);
  // Sub-unit instruments (FX/metals) need 5 decimals; large ones (BTC/indices) 2.
  const priceDec = bidPrice > 0 && bidPrice < 20 ? 5 : 2;
  // One "pip" step per instrument class so the +/- presets are sensible:
  // FX majors 0.0001, JPY/metals 0.01, large (BTC/indices) 1 point.
  const pipSize = bidPrice >= 1000 ? 1 : bidPrice >= 20 ? 0.01 : 0.0001;
  const pipPresets = [10, 20, 50, 100];

  // "Fijar TP/SL automáticamente" (Configuración): opt-in pre-fill of TP/SL with
  // ±50 pips when a market opens/changes. The user can still edit or disable.
  useEffect(() => {
    if (!autoTpSl || !hasData || !symbol) return;
    setTakeProfitEnabled(true);
    setStopLossEnabled(true);
    setTakeProfitPrice((lastPrice + 50 * pipSize).toFixed(priceDec));
    setStopLossPrice((lastPrice - 50 * pipSize).toFixed(priceDec));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoTpSl, symbol, hasData]);

  // ── AlphaTrader futures ticket (contracts) ───────────────────────────────
  if (isFutures) {
    const contractCount = Math.max(1, parseInt(volume || "1", 10) || 1);
    const clampQty = (n: number) => {
      const floored = Math.max(1, Math.round(n));
      return maxContracts != null && maxContracts > 0 ? Math.min(floored, maxContracts) : floored;
    };
    const setQty = (n: number) => setVolume(String(clampQty(n)));
    const stepQty = (d: number) => setQty(contractCount + d);
    const posPx = (v: number | null | undefined) => (v == null ? "—" : v.toFixed(v > 0 && v < 20 ? 5 : 2));
    const toggleBracket = (v: boolean) => {
      setBracketOn(v);
      setTakeProfitEnabled(v);
      setStopLossEnabled(v);
      if (v && hasData) {
        if (!(parseFloat(takeProfitPrice) > 0)) setTakeProfitPrice((lastPrice + 50 * pipSize).toFixed(priceDec));
        if (!(parseFloat(stopLossPrice) > 0)) setStopLossPrice((lastPrice - 50 * pipSize).toFixed(priceDec));
      }
    };
    const qtyPresets = [1, 3, 5, 10, 15];
    const secBtn = "h-9 rounded-md border border-white/12 bg-transparent text-[11px] font-semibold uppercase tracking-wide text-white/80 hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors";
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="px-3 py-2.5 border-b border-white/10 flex items-center justify-between gap-2 shrink-0">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-white/70">Order</span>
          <span className="text-[10px] text-white/40 uppercase tracking-wide">Futuros · Contratos</span>
        </div>
        <div className="px-3 pt-3 pb-2 space-y-3 overflow-y-auto flex-1">
          {/* CONTRACTS — etiqueta fija del símbolo activo (se cambia desde las tabs/watchlist). */}
          <div>
            <div className="text-[10px] text-white/45 uppercase tracking-wide mb-1">Contracts</div>
            <div className="flex items-center rounded-md border border-white/10 bg-[#151824] px-3 py-2 text-sm">
              <span className="truncate text-white/90">{symbol ? formatSymbolDisplay(symbol) : "Selecciona un símbolo"}</span>
            </div>
          </div>
          {/* ORDER TYPE — dropdown funcional Market / Limit / Stop */}
          <div>
            <div className="text-[10px] text-white/45 uppercase tracking-wide mb-1">Order Type</div>
            <div className="relative">
              <select
                value={orderType}
                onChange={(e) => setOrderType(e.target.value as OrderType)}
                className="w-full appearance-none rounded-md border border-white/10 bg-[#151824] px-3 py-2 pr-8 text-sm text-white/90 outline-none focus:border-white/25 cursor-pointer"
              >
                <option value="MERCADO">Market</option>
                <option value="LIMITE">Limit</option>
                <option value="STOP">Stop</option>
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-white/40" />
            </div>
          </div>
          {/* Precio de disparo (solo LIMIT/STOP) */}
          {isPending && (
            <div>
              <div className="text-[10px] text-white/45 uppercase tracking-wide mb-1">
                Precio {orderTypeLabel}
              </div>
              <Input
                type="number"
                inputMode="decimal"
                value={orderPrice}
                onChange={(e) => setOrderPrice(e.target.value)}
                placeholder={lastPrice > 0 ? String(lastPrice) : "Precio de disparo"}
                className="bg-[#151824] border-white/10 text-white/90"
              />
              <div className="mt-1 text-[10px] text-amber-400/80">
                Ejecución de órdenes {orderTypeLabel} disponible en cuentas MT5 reales — en esta cuenta sim solo opera a mercado.
              </div>
            </div>
          )}
          {/* # OF CONTRACTS */}
          <div>
            <div className="text-[10px] text-white/45 uppercase tracking-wide mb-1"># of Contracts</div>
            <Input
              value={volume}
              inputMode="numeric"
              onChange={(e) => setVolume(e.target.value.replace(/[^\d]/g, ""))}
              className="h-9 bg-[#151824] border-white/10 text-white tabular-nums"
            />
            <div className="text-[10px] text-white/40 mt-1 tabular-nums">
              {contractCount} contrato(s){maxContracts != null && maxContracts > 0 ? ` · máx ${maxContracts}` : ""}
            </div>
          </div>
          {/* Quick-qty row */}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => stepQty(-1)}
              className="h-8 w-8 shrink-0 rounded-md border border-white/10 bg-[#151824] text-white/80 hover:bg-white/10 transition-colors"
            >
              −
            </button>
            {qtyPresets.map((n) => {
              const active = contractCount === n;
              return (
                <button
                  key={n}
                  onClick={() => setQty(n)}
                  className={cn(
                    "h-8 flex-1 rounded-md border text-[12px] font-semibold tabular-nums transition-colors",
                    active ? "border-[#2f6bff] bg-[#2f6bff] text-white" : "border-white/10 bg-[#151824] text-white/70 hover:bg-white/10",
                  )}
                >
                  {n}
                </button>
              );
            })}
            <button
              onClick={() => stepQty(1)}
              className="h-8 w-8 shrink-0 rounded-md border border-white/10 bg-[#151824] text-white/80 hover:bg-white/10 transition-colors"
            >
              +
            </button>
          </div>
          {/* Active Positions */}
          <div>
            <div className="text-[10px] text-white/45 uppercase tracking-wide mb-1">Active Positions</div>
            <div
              className={cn(
                "rounded-md border px-3 py-2 text-sm text-center tabular-nums",
                activePosition ? "border-[#2f6bff]/40 bg-[#2f6bff]/10 text-white" : "border-white/10 bg-[#151824] text-white/45",
              )}
            >
              {activePosition
                ? `${activePosition.side === "LONG" ? "LONG" : "SHORT"} ${activePosition.qty} @ ${posPx(activePosition.avgPrice)}`
                : "No Active Positions"}
            </div>
          </div>
          {/* Bid / Last / Ask */}
          <div className="grid grid-cols-3 rounded-md overflow-hidden border border-white/10 text-center">
            <div className="bg-[#ef5350]/10 py-2">
              <div className="text-[9px] uppercase tracking-wide text-[#ef6863]">Bid</div>
              <div className="text-sm tabular-nums text-[#ff8580]">{hasData ? bidPrice.toFixed(priceDec) : "—"}</div>
            </div>
            <div className="bg-[#151824] py-2">
              <div className="text-[9px] uppercase tracking-wide text-white/45">Last</div>
              <div className="text-sm tabular-nums text-white/80">{hasData ? lastPrice.toFixed(priceDec) : "—"}</div>
            </div>
            <div className="bg-[#2ed68d]/10 py-2">
              <div className="text-[9px] uppercase tracking-wide text-[#42d99a]">Ask</div>
              <div className="text-sm tabular-nums text-[#5ce3ab]">{hasData ? askPrice.toFixed(priceDec) : "—"}</div>
            </div>
          </div>
          {/* OCO / Bracket */}
          <div className="rounded-md border border-white/10 bg-[#151824] px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[12px] font-semibold text-white/90">OCO/Bracket Order</div>
                <div className="text-[10px] text-white/45">One-Cancels-Other with TP/SL</div>
              </div>
              <Switch checked={bracketOn} onCheckedChange={toggleBracket} />
            </div>
            {bracketOn && (
              <div className="mt-3 space-y-2">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-[#2ed68d] mb-1">Take Profit</div>
                  <Input
                    value={takeProfitPrice}
                    onChange={(e) => setTakeProfitPrice(e.target.value)}
                    disabled={!hasData}
                    className="h-9 bg-[#0d0f16] border-white/10 text-white tabular-nums"
                    placeholder={hasData ? "" : "Sin precio"}
                  />
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-[#ef5350] mb-1">Stop Loss</div>
                  <Input
                    value={stopLossPrice}
                    onChange={(e) => setStopLossPrice(e.target.value)}
                    disabled={!hasData}
                    className="h-9 bg-[#0d0f16] border-white/10 text-white tabular-nums"
                    placeholder={hasData ? "" : "Sin precio"}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
        {/* BUY / SELL — @ MARKET (limit/stop se deshabilita hasta cablear su ejecución) */}
        <div className="grid grid-cols-2 gap-2 px-3 pt-2 shrink-0">
          <Button
            disabled={!ordersEnabled || !hasData || submitting || isPending}
            onClick={() => onSubmit("buy")}
            className="h-12 bg-[#1aa86a] hover:bg-[#1fbd78] text-white font-bold text-[13px] tracking-wide disabled:opacity-40"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : `BUY +${contractCount} @ ${orderTypeLabel}`}
          </Button>
          <Button
            disabled={!ordersEnabled || !hasData || submitting || isPending}
            onClick={() => onSubmit("sell")}
            className="h-12 bg-[#e0413d] hover:bg-[#ef5350] text-white font-bold text-[13px] tracking-wide disabled:opacity-40"
          >
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : `SELL -${contractCount} @ ${orderTypeLabel}`}
          </Button>
        </div>
        {/* Secondary actions */}
        <div className="grid grid-cols-2 gap-2 px-3 pt-2 pb-2 shrink-0">
          <Button variant="outline" disabled={!onClosePosition} onClick={onClosePosition} className={secBtn}>
            Close Position
          </Button>
          <Button
            variant="outline"
            disabled={!ordersEnabled || !activePosition || !onReverse}
            title={!activePosition ? "Sin posición abierta" : "Cierra y abre la opuesta"}
            onClick={onReverse}
            className={secBtn}
          >
            Reverse Position
          </Button>
          <Button
            variant="outline"
            disabled={!ordersEnabled || !onFlattenAll}
            title="Cierra todas las posiciones + cancela órdenes"
            onClick={onFlattenAll}
            className={secBtn}
          >
            Flatten All
          </Button>
          <Button
            variant="outline"
            disabled={!ordersEnabled || !onCancelAll}
            title="Cancela todas las órdenes pendientes"
            onClick={onCancelAll}
            className={secBtn}
          >
            Cancel All
          </Button>
        </div>
        <div className={cn("text-[10px] text-center py-1.5 border-t border-white/10 shrink-0", !ordersEnabled ? "text-[#e3b341]" : "text-white/40")}>
          {!ordersEnabled
            ? "Órdenes de futuros: próximamente · solo vista previa"
            : "Orden de mercado · Ejecución inmediata"}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 py-2 border-b border-white/10 flex items-center justify-between gap-2 shrink-0">
        <span className="text-sm font-semibold truncate">{symbol ? formatSymbolDisplay(symbol) : "Selecciona un símbolo"}</span>
        <select
          value={orderMode}
          onChange={(e) => setOrderMode(e.target.value as OrderMode)}
          className="shrink-0 rounded-md border border-white/10 bg-[#151824] px-2 py-1 text-[11px] text-white/80 outline-none hover:border-white/20 cursor-pointer"
          title="Modo de apertura de órdenes"
        >
          <option value="regular">Formulario regular</option>
          <option value="oneClick">Formulario con un clic</option>
          <option value="risk">Cálculo de riesgo</option>
        </select>
      </div>
      <div className="grid grid-cols-[1fr_60px_1fr] gap-2 px-3 pb-3 pt-1 shrink-0">
        <div className="flex flex-col items-center gap-1 rounded-lg border border-[#ef5350]/25 bg-[#ef5350]/10 px-2 py-2.5">
          <span className="text-[10px] font-semibold tracking-wide text-[#ef6863]">VENDER</span>
          <span className="text-base font-semibold text-[#ff8580] tabular-nums">{hasData ? bidPrice.toFixed(priceDec) : "—"}</span>
        </div>
        <div className="flex flex-col items-center justify-center gap-1 rounded-lg bg-[#151824] px-1 py-2.5">
          <span className="text-[9px] tracking-wide text-white/45">SPREAD</span>
          <span className="text-sm text-[#cdd3dd] tabular-nums">{hasData ? (spread * Math.pow(10, priceDec - 1)).toFixed(1) : "—"}</span>
        </div>
        <div className="flex flex-col items-center gap-1 rounded-lg border border-[#2ed68d]/25 bg-[#2ed68d]/10 px-2 py-2.5">
          <span className="text-[10px] font-semibold tracking-wide text-[#42d99a]">COMPRAR</span>
          <span className="text-base font-semibold text-[#5ce3ab] tabular-nums">{hasData ? askPrice.toFixed(priceDec) : "—"}</span>
        </div>
      </div>
      <div className="flex border-b border-white/10 shrink-0">
        {(["MERCADO", "LIMITE", "STOP"] as const).map((t) => {
          // Backend only executes market orders today; the other tabs are shown
          // disabled so the capability is clear instead of failing on submit.
          const disabled = t !== "MERCADO";
          return (
            <button
              key={t}
              disabled={disabled}
              title={disabled ? "Próximamente" : undefined}
              onClick={() => !disabled && setOrderType(t)}
              className={cn(
                "flex-1 py-2 text-xs font-semibold uppercase tracking-wider transition-colors",
                disabled && "opacity-30 cursor-not-allowed",
                orderType === t ? "text-white border-b-2 border-[#2f6bff]" : "text-white/50 hover:text-white/80",
              )}
            >
              {t}
            </button>
          );
        })}
      </div>
      <div className="px-3 py-3 space-y-3 overflow-y-auto flex-1">
        {isRisk && (
          <div className="rounded-lg border border-[#2f6bff]/25 bg-[#2f6bff]/5 p-2.5 space-y-2.5">
            <div className="text-[10px] text-[#7aa6ee] uppercase tracking-wider font-semibold">Cálculo de riesgo</div>
            <div>
              <div className="text-[10px] text-white/50 uppercase tracking-wider mb-1">Riesgo (% del capital)</div>
              <div className="flex items-center gap-2">
                <Input value={riskPct} onChange={(e) => setRiskPct(e.target.value)} className="h-9 text-center bg-white/5 border-white/10 text-white tabular-nums" />
                <div className="grid grid-cols-3 gap-1">
                  {["0.5", "1", "2"].map((p) => (
                    <Button key={p} variant="outline" size="sm" className="h-9 px-2 text-[10px] bg-white/5 border-white/10 text-white/70 hover:bg-white/10" onClick={() => setRiskPct(p)}>
                      {p}%
                    </Button>
                  ))}
                </div>
              </div>
            </div>
            <div>
              <div className="text-[10px] text-white/50 uppercase tracking-wider mb-1">Stop Loss (precio)</div>
              <Input value={stopLossPrice} onChange={(e) => setStopLossPrice(e.target.value)} disabled={!hasData} placeholder={hasData ? "Define el SL para calcular" : "Sin precio"} className="h-9 bg-white/5 border-white/10 text-white tabular-nums" />
            </div>
            <div className="flex items-center justify-between text-[11px] pt-0.5">
              <span className="text-white/50">Riesgo ≈ <span className="text-[#ef5350] font-semibold tabular-nums">{estRisk > 0 ? `$${estRisk.toFixed(2)}` : "—"}</span></span>
              <span className="text-white/50">{strategy.unitLabel} ≈ <span className="text-white font-semibold tabular-nums">{computedSize > 0 ? strategy.formatVolume(computedSize) : "—"}</span></span>
            </div>
          </div>
        )}
        <div>
          <div className="text-[10px] text-white/50 uppercase tracking-wider mb-1.5">Volumen ({strategy.unitLabel}){isRisk && " · calculado"}</div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={isRisk} className="h-9 w-9 bg-white/5 border-white/10 text-white hover:bg-white/10 disabled:opacity-30" onClick={() => setVolume(strategy.formatVolume(Math.max(strategy.minVolume, parseFloat(volume) - strategy.volumeStep)))}>−</Button>
            <Input value={volume} readOnly={isRisk} onChange={(e) => setVolume(e.target.value)} className="h-9 text-center bg-white/5 border-white/10 text-white" />
            <Button variant="outline" size="sm" disabled={isRisk} className="h-9 w-9 bg-white/5 border-white/10 text-white hover:bg-white/10 disabled:opacity-30" onClick={() => setVolume(strategy.formatVolume(parseFloat(volume) + strategy.volumeStep))}>+</Button>
          </div>
          <div className="text-[11px] text-white/50 mt-1 tabular-nums">
            {isFutures
              ? `${parseInt(volume || "0", 10) || 0} contrato(s)${maxContracts != null && maxContracts > 0 ? ` · máx ${maxContracts}` : ""}`
              : hasData ? `≈ $${notional.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "Sin precio disponible"}
          </div>
        </div>
        {!isOneClick && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-white/50 uppercase tracking-wider">Take Profit</span>
            <Switch
              checked={takeProfitEnabled}
              onCheckedChange={(v) => {
                setTakeProfitEnabled(v);
                // Default TP to +50 pips so the user can leave it as-is.
                if (v && hasData && !(parseFloat(takeProfitPrice) > 0)) {
                  setTakeProfitPrice((lastPrice + 50 * pipSize).toFixed(priceDec));
                }
              }}
            />
          </div>
          <Input value={takeProfitPrice} onChange={(e) => setTakeProfitPrice(e.target.value)} disabled={!takeProfitEnabled || !hasData} className="h-9 bg-white/5 border-white/10 text-white tabular-nums" placeholder={hasData ? "" : "Sin precio"} />
          {takeProfitEnabled && parseFloat(takeProfitPrice) > 0 && hasData && (
            <div className="text-[11px] text-emerald-400 mt-1 text-right tabular-nums">
              +${(parseFloat(takeProfitPrice) - lastPrice).toFixed(2)}
            </div>
          )}
          {hasData && takeProfitEnabled && (
            <div className="grid grid-cols-4 gap-1 mt-1.5">
              {pipPresets.map((d) => (
                <Button key={d} variant="outline" size="sm" className="h-7 text-[10px] bg-white/5 border-white/10 text-white/70 hover:bg-white/10"
                  onClick={() => setTakeProfitPrice((lastPrice + d * pipSize).toFixed(priceDec))}
                >
                  +{d}p
                </Button>
              ))}
            </div>
          )}
        </div>
        )}
        {!isOneClick && !isRisk && (
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-white/50 uppercase tracking-wider">Stop Loss</span>
            <Switch
              checked={stopLossEnabled}
              onCheckedChange={(v) => {
                setStopLossEnabled(v);
                // Default SL to −50 pips so the user can leave it as-is.
                if (v && hasData && !(parseFloat(stopLossPrice) > 0)) {
                  setStopLossPrice((lastPrice - 50 * pipSize).toFixed(priceDec));
                }
              }}
            />
          </div>
          <Input value={stopLossPrice} onChange={(e) => setStopLossPrice(e.target.value)} disabled={!stopLossEnabled || !hasData} className="h-9 bg-white/5 border-white/10 text-white tabular-nums" placeholder={hasData ? "" : "Sin precio"} />
          {stopLossEnabled && parseFloat(stopLossPrice) > 0 && hasData && (
            <div className="text-[11px] text-red-400 mt-1 text-right tabular-nums">
              −${Math.abs(lastPrice - parseFloat(stopLossPrice)).toFixed(2)}
            </div>
          )}
          {hasData && stopLossEnabled && (
            <div className="grid grid-cols-4 gap-1 mt-1.5">
              {pipPresets.map((d) => (
                <Button key={d} variant="outline" size="sm" className="h-7 text-[10px] bg-white/5 border-white/10 text-white/70 hover:bg-white/10"
                  onClick={() => setStopLossPrice((lastPrice - d * pipSize).toFixed(priceDec))}
                >
                  −{d}p
                </Button>
              ))}
            </div>
          )}
        </div>
        )}
        {!isOneClick && (
        <div className="grid grid-cols-3 gap-2 text-[10px]">
          <div>
            <div className="text-white/50 uppercase tracking-wider">Ratio</div>
            <div className="text-sm font-bold text-white mt-0.5">{ratio}</div>
          </div>
          <div>
            <div className="text-white/50 uppercase tracking-wider">Riesgo</div>
            <div className="text-sm font-bold text-red-400 mt-0.5 tabular-nums">−${risk.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-white/50 uppercase tracking-wider">Premio</div>
            <div className="text-sm font-bold text-emerald-400 mt-0.5 tabular-nums">+${reward.toFixed(2)}</div>
          </div>
        </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 p-3 border-t border-white/10 shrink-0">
        <Button
          disabled={!ordersEnabled || !hasData || submitting || (isRisk && computedSize <= 0)}
          onClick={() => onSubmit("sell")}
          className="h-12 bg-[#e0413d] hover:bg-[#ef5350] text-white font-bold text-sm tracking-wide disabled:opacity-40"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "VENDER"}
        </Button>
        <Button
          disabled={!ordersEnabled || !hasData || submitting || (isRisk && computedSize <= 0)}
          onClick={() => onSubmit("buy")}
          className="h-12 bg-[#1aa86a] hover:bg-[#1fbd78] text-white font-bold text-sm tracking-wide disabled:opacity-40"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "COMPRAR"}
        </Button>
      </div>
      <div className={cn("text-[10px] text-center py-1.5 border-t border-white/10 shrink-0", !ordersEnabled ? "text-[#e3b341]" : isOneClick ? "text-[#e3b341]" : "text-white/40")}>
        {!ordersEnabled
          ? "Órdenes de futuros: próximamente · solo vista previa de tamaño"
          : isOneClick
            ? "Un clic · ejecución SIN confirmación"
            : isRisk
              ? "Lotes calculados por riesgo · se pedirá confirmación"
              : "Orden de mercado · Ejecución inmediata"}
      </div>
    </div>
  );
}