import { useQuery } from "@tanstack/react-query";
import { nestAuthFetch } from "@/api/client";
import { readStoredAuth } from "@/contexts/AuthContext";
import { listMt5Accounts } from "@/services/tradingConfig.service";
import type { CopyTradingAccountSummary } from "../types";

type MT5AccountRow = {
  id: string;
  account_name: string | null;
  mt5_account_id: string | null;
  bridge_instance?: number | null;
  connection_status: string | null;
  is_default: boolean;
  balance: number | null;
  equity: number | null;
  margin?: number | null;
  free_margin?: number | null;
  floating_pnl?: number | null;
  last_balance_sync_at?: string | null;
  last_verified_at?: string | null;
};
const ACCOUNT_LOCK_SENTINEL_SYMBOL = "__ACCOUNT_LOCK__";
const LOG_THROTTLE_MS = 120_000;
const warnedAt = new Map<string, number>();

type RiskSessionSnapshot = {
  accountId: string | null;
  balanceUsd?: number | null;
  equityUsd?: number | null;
  profile?: {
    name?: string | null;
  } | null;
  limits?: {
    riskPerTradeUsd?: number | null;
    dailyLossLimitUsd?: number | null;
    dailyProfitTargetUsd?: number | null;
  } | null;
  meta?: {
    accountBalanceUsd?: number | null;
    accountEquityUsd?: number | null;
  } | null;
};

function asFiniteNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asPositiveNumber(value: unknown): number | null {
  const parsed = asFiniteNumber(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function shouldLog(key: string): boolean {
  const now = Date.now();
  const prev = warnedAt.get(key) ?? 0;
  if (now - prev < LOG_THROTTLE_MS) return false;
  warnedAt.set(key, now);
  return true;
}

function toStatus(raw: unknown): "connected" | "pending" | "error" | "attention_required" | "disconnected" {
  const value = String(raw || "").toLowerCase();
  if (value === "connected" || value === "pending" || value === "error" || value === "attention_required") return value;
  return "disconnected";
}

function lockReasonLabel(
  status: string,
  isManualLocked: boolean,
  isBridgeAssigned: boolean,
): string | null {
  if (isManualLocked) return "Bloqueada manualmente";
  if (!isBridgeAssigned) return "Sin instancia MT5";
  if (status === "error") return "Error de conexión";
  if (status === "attention_required") return "Requiere atención";
  if (status === "pending") return "Pendiente de verificación";
  if (status !== "connected") return "Sin conexión";
  return null;
}

export async function fetchUnifiedTradingAccountsForUser(userId: string): Promise<CopyTradingAccountSummary[]> {
  const riskSessionsRequest = nestAuthFetch<RiskSessionSnapshot[]>("/api/risk-engine/sessions").catch((error) => {
    if (shouldLog(`risk-sessions-unavailable:${userId}`)) {
      console.warn("[CopyTradingGroups] Risk Engine sessions unavailable", error);
    }
    return [] as RiskSessionSnapshot[];
  });

  const [accountsData, lockRows, unifiedRowsRaw, riskSessions] = await Promise.all([
    listMt5Accounts(),
    nestAuthFetch<Array<{ account_id: string; follow_enabled: boolean; symbol: string }>>(
      `/api/functions/copy-follow-settings?symbols=${encodeURIComponent(ACCOUNT_LOCK_SENTINEL_SYMBOL)}`,
    ).catch(() => [] as Array<{ account_id: string; follow_enabled: boolean; symbol: string }>),
    nestAuthFetch<unknown[]>("/api/functions/trading-accounts").catch(() => []),
    riskSessionsRequest,
  ]);

  const mt5Rows = (Array.isArray(accountsData) ? accountsData : []) as MT5AccountRow[];
  const safeLockRows = Array.isArray(lockRows) ? lockRows : [];
  const unifiedRows = (Array.isArray(unifiedRowsRaw) ? unifiedRowsRaw : []) as Array<{
    id: string;
    provider: "mt5_bridge" | "tradovate" | "topstepx" | string;
    prop_firm: string | null;
    label: string | null;
    external_account_id: string | null;
    connection_status: string | null;
    last_error: string | null;
  }>;
  const safeRiskSessions = Array.isArray(riskSessions) ? riskSessions : [];

  const manuallyLockedAccountIds = new Set(
    safeLockRows
      .filter((row) => row && row.symbol === ACCOUNT_LOCK_SENTINEL_SYMBOL && row.follow_enabled === false)
      .map((row) => row.account_id),
  );

  const mt5Accounts: CopyTradingAccountSummary[] = mt5Rows.map((row) => {
    const isManualLocked = manuallyLockedAccountIds.has(row.id);
    const bridgeInstance = Number(row.bridge_instance);
    const isBridgeAssigned = Number.isFinite(bridgeInstance) && bridgeInstance > 0;
    const status = isBridgeAssigned ? toStatus(row.connection_status) : "disconnected";
    const available = status === "connected" && !isManualLocked;

    const session = safeRiskSessions.find((s) => s?.accountId === row.id) ?? null;
    const balanceUsd = asFiniteNumber(row.balance) ?? asFiniteNumber(session?.meta?.accountBalanceUsd) ?? asFiniteNumber(session?.balanceUsd);
    const equityUsd = asFiniteNumber(row.equity) ?? asFiniteNumber(session?.meta?.accountEquityUsd) ?? asFiniteNumber(session?.equityUsd);
    const baseCapital = asPositiveNumber(session?.balanceUsd);
    const riskPerTradeUsd = asPositiveNumber(session?.limits?.riskPerTradeUsd);
    const dailyLossLimitUsd = asPositiveNumber(session?.limits?.dailyLossLimitUsd);
    const dailyProfitTargetUsd = asPositiveNumber(session?.limits?.dailyProfitTargetUsd);
    const hasValidRiskSnapshot = Boolean(session && baseCapital && riskPerTradeUsd && dailyLossLimitUsd);
    const riskStatus = hasValidRiskSnapshot
      ? "ready"
      : session
        ? "missing_balance"
        : "missing_snapshot";

    const waitingConnection = status === "pending" || status === "attention_required";
    if (!hasValidRiskSnapshot && status === "connected" && !waitingConnection) {
      const reason = session ? "missing_balance_or_limits" : "missing_snapshot";
      const logKey = `risk-snapshot:${row.id}:${reason}`;
      if (shouldLog(logKey)) {
        console.warn("[CopyTradingGroups] Account cannot be used for copy trading without a valid Risk Engine snapshot", {
          accountId: row.id,
          mt5AccountId: row.mt5_account_id,
          reason,
        });
      }
    }

    return {
      id: row.id,
      accountSource: "mt5_accounts",
      providerKey: "mt5_bridge",
      connectionId: "mt5_bridge",
      connectionName: "Cuentas:",
      provider: "MT5 Bridge",
      label: row.account_name,
      propFirm: null,
      externalAccountId: row.mt5_account_id ?? null,
      connectionStatus: status,
      lastError: null,
      accountName: row.account_name || row.mt5_account_id || "Cuenta MT5",
      mt5AccountId: row.mt5_account_id ?? null,
      balanceUsd,
      equityUsd,
      margin: asFiniteNumber(row.margin),
      freeMargin: asFiniteNumber(row.free_margin),
      floatingPnl: asFiniteNumber(row.floating_pnl),
      lastBalanceSyncAt: row.last_balance_sync_at,
      riskProfileName: session?.profile?.name ?? null,
      riskPerTradeUsd,
      dailyLossLimitUsd,
      dailyProfitTargetUsd,
      riskStatus,
      riskStatusLabel: hasValidRiskSnapshot ? null : session ? "Sin configurar" : "Sin datos de riesgo",
      status: available ? "available" : "locked",
      manualLocked: isManualLocked,
      lockRemainingLabel: lockReasonLabel(status, isManualLocked, isBridgeAssigned),
    };
  });

  const providerLabelByKey: Record<string, { connection: string; provider: string }> = {
    tradovate: { connection: "Tradovate", provider: "Tradovate" },
    topstepx: { connection: "TopstepX", provider: "TopstepX" },
  };

  const tradingAccounts: CopyTradingAccountSummary[] = unifiedRows
    .filter((row) => row.provider === "tradovate" || row.provider === "topstepx")
    .map((row) => {
      const isManualLocked = manuallyLockedAccountIds.has(row.id);
      const status = toStatus(row.connection_status);
      const available = status === "connected" && !isManualLocked;
      const labels = providerLabelByKey[row.provider] ?? { connection: "Broker", provider: "Broker API" };
      const fallbackName = row.external_account_id || row.id;
      return {
        id: row.id,
        accountSource: "trading_accounts",
        providerKey: row.provider === "topstepx" ? "topstepx" : "tradovate",
        connectionId: row.provider,
        connectionName: labels.connection,
        provider: labels.provider,
        label: row.label,
        propFirm: row.prop_firm,
        externalAccountId: row.external_account_id,
        connectionStatus: status,
        lastError: row.last_error ?? null,
        accountName: row.label || fallbackName,
        mt5AccountId: null,
        balanceUsd: null,
        equityUsd: null,
        riskProfileName: null,
        riskPerTradeUsd: null,
        dailyLossLimitUsd: null,
        dailyProfitTargetUsd: null,
        riskStatus: "missing_snapshot",
        riskStatusLabel: "Sin datos de riesgo",
        status: available ? "available" : "locked",
        manualLocked: isManualLocked,
        lockRemainingLabel: lockReasonLabel(status, isManualLocked, true),
      };
    });

  return [...mt5Accounts, ...tradingAccounts];
}

export function useTradingAccounts(provider?: "mt5_bridge" | "tradovate" | "topstepx") {
  return useQuery({
    queryKey: ["copy-trading", "trading-accounts", provider ?? "all"],
    queryFn: async (): Promise<CopyTradingAccountSummary[]> => {
      const stored = readStoredAuth();
      const user = stored?.user ?? null;

      if (!user) return [];

      const rows = await fetchUnifiedTradingAccountsForUser(user.id);
      if (!provider) return rows;
      return rows.filter((row) => row.providerKey === provider);
    },
    staleTime: 20_000,
  });
}
