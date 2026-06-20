import { useQuery } from "@tanstack/react-query";
import { nestAuthFetch } from "@/api/client";
import { readStoredAuth } from "@/contexts/AuthContext";
import { CopyTradingConnectionsPayload } from "../types";
import { fetchUnifiedTradingAccountsForUser } from "./useTradingAccounts";

const LEADER_GROUP_SENTINEL_SYMBOL = "__LEADER_GROUP__";

export function useConnections() {
  return useQuery({
    queryKey: ["copy-trading", "connections"],
    queryFn: async (): Promise<CopyTradingConnectionsPayload> => {
      const stored = readStoredAuth();
      const user = stored?.user ?? null;

      if (!user) {
        return { leaderAccountId: null, followerAccountIds: [], groups: [] };
      }

      const [settingsRow, followerRows, unifiedAccounts] = await Promise.all([
        nestAuthFetch<{ user_id: string; leader_account_id: string | null } | null>(
          "/api/functions/copy-trading-settings",
        ).catch(() => null),
        nestAuthFetch<Array<{ account_id: string; follow_enabled: boolean }>>(
          `/api/functions/copy-follow-settings?symbols=${encodeURIComponent(LEADER_GROUP_SENTINEL_SYMBOL)}`,
        ).catch(() => [] as Array<{ account_id: string; follow_enabled: boolean }>),
        fetchUnifiedTradingAccountsForUser(user.id),
      ]);

      const followerAccountIds = Array.from(
        new Set(
          (followerRows ?? [])
            .filter((row) => row?.follow_enabled === true)
            .map((row) => String(row?.account_id || "").trim())
            .filter((value) => value.length > 0),
        ),
      );

      if (unifiedAccounts.length === 0) {
        return {
          leaderAccountId: null,
          followerAccountIds,
          groups: [],
        };
      }

      const visibleAccounts = unifiedAccounts.filter(
        (account) =>
          account.accountSource !== "mt5_accounts" ||
          (account.connectionStatus === "connected" && Boolean(account.mt5AccountId)),
      );

      return {
        leaderAccountId: settingsRow?.leader_account_id ?? null,
        followerAccountIds,
        groups: Array.from(
          visibleAccounts.reduce((acc, account) => {
            const providerKey = account.providerKey ?? "mt5_bridge";
            const groupId = `provider:${providerKey}`;
            if (!acc.has(groupId)) {
              acc.set(groupId, {
                id: groupId,
                connectionName: account.connectionName,
                provider: account.provider,
                accounts: [] as typeof visibleAccounts,
              });
            }
            acc.get(groupId)!.accounts.push(account);
            return acc;
          }, new Map<string, { id: string; connectionName: string; provider: string; accounts: typeof visibleAccounts }>()),
        ).map(([, group]) => ({
          ...group,
          accounts: group.accounts,
        })),
      };
    },
    staleTime: 20_000,
  });
}
