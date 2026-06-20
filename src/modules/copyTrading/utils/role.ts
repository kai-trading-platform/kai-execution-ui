export interface CopyTradingRoleResult {
  role: "leader" | "follower" | "none";
  label: "Líder" | "Seguidora" | "Sin rol";
  variant: "blue" | "green" | "gray";
}

export function getCopyTradingRole(
  accountId: string,
  leaderAccountId: string | null | undefined,
  followerAccountIdSet: Set<string> | string[]
): CopyTradingRoleResult {
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedLeaderId = String(leaderAccountId || "").trim();

  // Convert array/set to a Set for fast lookup
  const followersSet = followerAccountIdSet instanceof Set
    ? followerAccountIdSet
    : new Set(followerAccountIdSet || []);

  if (normalizedLeaderId && normalizedAccountId === normalizedLeaderId) {
    return {
      role: "leader",
      label: "Líder",
      variant: "green",
    };
  }

  if (followersSet.has(normalizedAccountId)) {
    return {
      role: "follower",
      label: "Seguidora",
      variant: "blue",
    };
  }

  return {
    role: "none",
    label: "Sin rol",
    variant: "gray",
  };
}
