import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { nestAuthFetch } from "@/api/client";
import { readStoredAuth } from "@/contexts/AuthContext";
import { isMt5AccountFullyConnected, listMt5Accounts } from "@/services/tradingConfig.service";
import { CopyTradingPosition } from "../types";

const POSITIONS_QUERY_KEY = ["copy-trading", "positions"] as const;

type CopyPositionRow = {
  id: string;
  account_id: string;
  created_at: string | null;
  symbol: string;
  side: string;
  avg_price: number | string | null;
  current_price?: number | string | null;
  tp?: number | string | null;
  sl?: number | string | null;
  day_pnl_usd: number | string | null;
  open_pnl_usd: number | string | null;
  qty: number | string | null;
  contract_size?: number | string | null;
};
type ExtendedCopyPositionRow = CopyPositionRow & {
  id?: string | number | null;
  tp?: number | string | null;
  sl?: number | string | null;
};
type MT5AccountRow = {
  id: string;
  account_name: string | null;
  balance: number | string | null;
  mt5_account_id: string;
  bridge_instance?: number | null;
  connection_status: string | null;
};
type CopyFollowSettingRow = {
  account_id: string;
  symbol: string;
  follow_enabled: boolean;
};
type CopyGroupFollowerRow = {
  account_id: string;
};

type ToggleFollowInput = {
  position: Pick<CopyTradingPosition, "id" | "accountId" | "symbol">;
  checked: boolean;
};
type UpsertCopyFollowSettingPayload = {
  account_id: string;
  symbol: string;
  follow_enabled: boolean;
};

function toFiniteNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const cleaned = String(value).replace(/,/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNullablePositiveNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeSide(value: string | null | undefined): "LONG" | "SHORT" {
  return String(value || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
}

function positionFollowKey(accountId: string, symbol: string) {
  return `${accountId}::${symbol}`;
}

function getAuthenticatedUserId(): string | null {
  const state = readStoredAuth();
  return state?.user?.id ?? null;
}

async function fetchOpenPositions(): Promise<CopyTradingPosition[]> {
  const userId = getAuthenticatedUserId();
  if (!userId) return [];

  const positionRows = await nestAuthFetch<CopyPositionRow[]>("/api/functions/copy-positions");

  const rows = (positionRows ?? []) as ExtendedCopyPositionRow[];
  if (rows.length === 0) return [];

  const accountIds = Array.from(new Set(rows.map((row) => row.account_id).filter(Boolean)));
  const symbols = Array.from(new Set(rows.map((row) => row.symbol).filter(Boolean)));

  const accountsPromise = accountIds.length
    ? listMt5Accounts().then((data) => ({
        data: data.filter((row) => accountIds.includes(row.id) && isMt5AccountFullyConnected(row)),
        error: null,
      }))
    : Promise.resolve({ data: [], error: null });

  const accountIdsParam = accountIds.join(',');
  const symbolsParam = symbols.join(',');

  const followPromise = accountIds.length && symbols.length
    ? nestAuthFetch<CopyFollowSettingRow[]>(`/api/functions/copy-follow-settings?account_ids=${encodeURIComponent(accountIdsParam)}&symbols=${encodeURIComponent(symbolsParam)}`)
    : Promise.resolve([]);

  const groupFollowPromise = accountIds.length
    ? nestAuthFetch<CopyGroupFollowerRow[]>(`/api/functions/copy-group-followers?account_ids=${encodeURIComponent(accountIdsParam)}`)
    : Promise.resolve([]);

  const [accountsRes, follows, groupFollowRows] = await Promise.all([
    accountsPromise,
    followPromise,
    groupFollowPromise,
  ]);

  if (accountsRes.error) throw accountsRes.error;

  const accounts = (accountsRes.data ?? []) as MT5AccountRow[];
  const followerAccountIds = new Set(
    groupFollowRows.map((row: CopyGroupFollowerRow) => row.account_id),
  );

  const accountMap = new Map(accounts.map((row) => [row.id, row]));
  const connectedRows = rows.filter((row) => accountMap.has(row.account_id));
  const followMap = new Map(
    follows.map((row) => [positionFollowKey(row.account_id, row.symbol), row.follow_enabled]),
  );

  const hydratedPositions = connectedRows.map((row) => {
    const account = accountMap.get(row.account_id);
    const symbol = row.symbol || "—";

    return {
      id: row.id,
      connection: "MT5 Bridge",
      accountId: row.account_id,
      accountName: account?.account_name || row.account_id,
      openedAtIso:
        typeof row.created_at === "string" && row.created_at.trim().length > 0
          ? row.created_at
          : null,
      symbol,
      side: normalizeSide(row.side),
      balanceUsd: account?.balance == null ? null : toFiniteNumber(account.balance, 0),
      avgPrice: toFiniteNumber(row.avg_price, 0),
      currentPrice: toFiniteNumber(row.current_price, toFiniteNumber(row.avg_price, 0)),
      tp: toNullablePositiveNumber(row.tp),
      sl: toNullablePositiveNumber(row.sl),
      dayPnlUsd: toFiniteNumber(row.day_pnl_usd, 0),
      openPnlUsd: toFiniteNumber(row.open_pnl_usd, 0),
      qty: toFiniteNumber(row.qty, 0),
      contractSize: toFiniteNumber(row.contract_size, 0),
      ratio: 1.0,
      follow: followMap.get(positionFollowKey(row.account_id, symbol)) ?? true,
      isFollower: followerAccountIds.has(row.account_id),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      protectionStatus: (row as any).protection_status ?? null,
    } satisfies CopyTradingPosition;
  });

  return hydratedPositions;
}

export function usePositions() {
  return useQuery({
    queryKey: POSITIONS_QUERY_KEY,
    queryFn: fetchOpenPositions,
    staleTime: 5_000,
    refetchInterval: 15_000,
  });
}

export function useToggleFollowSetting() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ position, checked }: ToggleFollowInput) => {
      const userId = getAuthenticatedUserId();
      if (!userId) throw new Error("Debes iniciar sesión");

      const payload: UpsertCopyFollowSettingPayload = {
        account_id: position.accountId,
        symbol: position.symbol,
        follow_enabled: checked,
      };

      await nestAuthFetch("/api/functions/copy-follow-settings", {
        method: "POST",
        json: payload,
      });
    },
    onMutate: async ({ position, checked }) => {
      await queryClient.cancelQueries({ queryKey: POSITIONS_QUERY_KEY });
      const previous = queryClient.getQueryData<CopyTradingPosition[]>(POSITIONS_QUERY_KEY);

      queryClient.setQueryData<CopyTradingPosition[]>(POSITIONS_QUERY_KEY, (current = []) =>
        current.map((row) => (row.id === position.id ? { ...row, follow: checked } : row)),
      );

      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(POSITIONS_QUERY_KEY, context.previous);
      }
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: POSITIONS_QUERY_KEY });
    },
  });
}

export { POSITIONS_QUERY_KEY };
