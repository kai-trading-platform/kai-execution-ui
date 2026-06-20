import { nestAuthFetch } from "@/api/client";

// ─── Auto Trading Jobs ───────────────────────────────────────────────────────

export interface AutoTradingJobRecord {
    id: string;
    user_id: string;
    symbol: string;
    interval_minutes: number;
    selected_system: string;
    status: string;
    signals_generated: number;
    hold_count: number;
    analysis_count: number;
    consecutive_errors: number | null;
    last_error_at: string | null;
    last_signal_at: string | null;
    started_at: string;
    ends_at: string;
    last_evaluation_at: string | null;
    engine_status: string | null;
    waiting_event: string | null;
    created_at: string;
    updated_at: string;
}

export interface AutoTradingJobCount {
    active: number;
    auto_paused: number;
    total: number;
}

export interface TradingPerformanceSummary {
    as_of: string;
    window_days: number;
    symbol: string | null;
    model: "CAMARON" | null;
    totals: {
        resolved_trades: number;
        wins: number;
        losses: number;
        breakeven: number;
        win_rate_pct: number;
        expectancy_r: number;
        average_r: number;
        average_win_r: number | null;
        average_loss_r: number | null;
        profit_factor: number | null;
        net_r: number;
        max_drawdown_r: number;
        net_usd: number | null;
        max_drawdown_usd: number | null;
        recent_loss_streak: number;
    };
    directional: {
        buy: {
            resolved_trades: number;
            win_rate_pct: number;
            expectancy_r: number;
            recent_loss_streak: number;
        };
        sell: {
            resolved_trades: number;
            win_rate_pct: number;
            expectancy_r: number;
            recent_loss_streak: number;
        };
    };
    edge: {
        regime: "STRONG" | "NEUTRAL" | "WEAK" | "UNPROVEN";
        recommendation: "RUN" | "CAUTION" | "PAUSE";
        reasons: string[];
    };
}

export async function listAutoTradingJobs(params?: { status?: string[] }): Promise<AutoTradingJobRecord[]> {
    const qs = params?.status?.length ? `?status=${params.status.join(',')}` : '';
    return nestAuthFetch<AutoTradingJobRecord[]>(`/api/auto-trading-jobs${qs}`);
}

export async function countAutoTradingJobs(): Promise<AutoTradingJobCount> {
    return nestAuthFetch<AutoTradingJobCount>('/api/auto-trading-jobs/count');
}

export async function getTradingPerformanceSummary(params?: {
    days?: number;
    symbol?: string;
    model?: "CAMARON";
    accountId?: string;
}): Promise<TradingPerformanceSummary> {
    const query = new URLSearchParams();
    if (typeof params?.days === "number" && Number.isFinite(params.days)) {
        query.set("days", String(Math.max(1, Math.floor(params.days))));
    }
    if (params?.symbol) {
        query.set("symbol", params.symbol);
    }
    if (params?.model) {
        query.set("model", params.model);
    }
    if (params?.accountId) {
        query.set("accountId", params.accountId);
    }
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : "";
    return nestAuthFetch<TradingPerformanceSummary>(
        `/api/trading-signals/performance/me${suffix}`,
    );
}

export async function getMt5PerformanceSummary(params?: {
    days?: number;
    accountId?: string;
}): Promise<TradingPerformanceSummary> {
    const query = new URLSearchParams();
    if (typeof params?.days === "number" && Number.isFinite(params.days)) {
        query.set("days", String(Math.max(1, Math.floor(params.days))));
    }
    if (params?.accountId) {
        query.set("accountId", params.accountId);
    }
    const suffix = query.toString().length > 0 ? `?${query.toString()}` : "";
    return nestAuthFetch<TradingPerformanceSummary>(
        `/api/trading-signals/performance/mt5/me${suffix}`,
    );
}

export async function createAutoTradingJob(payload: {
    symbol: string;
    interval_minutes: number;
    selected_system: string;
    status: string;
    ends_at: string;
}): Promise<AutoTradingJobRecord> {
    return nestAuthFetch<AutoTradingJobRecord>('/api/auto-trading-jobs', {
        method: 'POST',
        json: payload,
    });
}

export async function updateAutoTradingJob(
    jobId: string,
    payload: Partial<Pick<AutoTradingJobRecord, 'status' | 'interval_minutes' | 'ends_at' | 'selected_system' | 'waiting_event' | 'consecutive_errors' | 'last_error_at'>>,
): Promise<AutoTradingJobRecord> {
    return nestAuthFetch<AutoTradingJobRecord>(`/api/auto-trading-jobs/${jobId}`, {
        method: 'PATCH',
        json: payload,
    });
}

export async function deleteAutoTradingJob(jobId: string): Promise<{ ok: boolean }> {
    return nestAuthFetch<{ ok: boolean }>(`/api/auto-trading-jobs/${jobId}`, {
        method: 'DELETE',
    });
}

export async function bulkDeleteAutoTradingJobs(params: {
    ids?: string[];
    statuses?: string[];
}): Promise<{ ok: boolean }> {
    return nestAuthFetch<{ ok: boolean }>('/api/auto-trading-jobs', {
        method: 'DELETE',
        json: params,
    });
}

export type RiskProfileName =
    | "conservative"
    | "moderate"
    | "aggressive";

export type TradingModeValue = "DAY_TRADING";
export type TradingModelValue = "CAMARON";

export interface Mt5AccountRecord {
    id: string;
    user_id: string;
    account_name: string;
    server?: string | null;
    mt5_account_id: string;
    bridge_instance?: number | null;
    mt5_password?: string;
    account_type: "demo" | "real";
    is_default: boolean;
    connection_status: "connected" | "disconnected" | "pending" | "error" | "preparing" | "connecting" | "reconnecting" | "recovering" | "unhealthy" | "failed" | "attention_required" | "idle";
    last_verified_at: string | null;
    balance: number | null;
    equity: number | null;
    margin?: number | null;
    free_margin?: number | null;
    floating_pnl?: number | null;
    last_balance_sync_at?: string | null;
    created_at: string;
    updated_at: string;
    risk_profile_name: RiskProfileName;
    risk_per_trade: number;
    max_daily_loss: number;
    max_daily_trades: number;
    risk_reward_ratio: number;
    trading_model: TradingModelValue;
    trailing_stop_enabled: boolean;
    last_error_code?: string | null;
    last_error_message_user?: string | null;
    last_error_message_dev?: string | null;
    last_connection_attempt_at?: string | null;
}

export function isMt5AccountFullyConnected(account: Pick<Mt5AccountRecord, "bridge_instance" | "connection_status" | "is_default">): boolean {
    const bridgeInstance = Number(account.bridge_instance);
    const hasAssignedBridge = Number.isFinite(bridgeInstance) && bridgeInstance > 0;
    return account.connection_status === "connected" && (hasAssignedBridge || account.is_default === true);
}

export interface UserRiskSettingsRecord {
    user_id: string;
    profile_name: RiskProfileName;
    risk_per_trade: number;
    max_daily_loss: number;
    max_daily_trades: number;
    balance: number;
    created_at: string;
    updated_at: string;
    trading_mode: TradingModeValue;
    risk_reward_ratio: number;
    execution_mode: "SINGLE";
    trading_model: TradingModelValue;
    auto_protection_disabled?: boolean;
    market_close_settings?: Record<string, { closeMinutesBefore?: number }>;
}

export async function listMt5Accounts(): Promise<Mt5AccountRecord[]> {
    return nestAuthFetch<Mt5AccountRecord[]>("/api/mt5-accounts");
}

export async function getVerifiedMt5Servers(): Promise<Array<{ value: string; label: string }>> {
    return nestAuthFetch<Array<{ value: string; label: string }>>("/api/mt5-accounts/servers");
}

export async function createMt5Account(
    payload: Partial<Mt5AccountRecord & { force_account_type?: boolean }>,
): Promise<Mt5AccountRecord> {
    return nestAuthFetch<Mt5AccountRecord>("/api/mt5-accounts", {
        method: "POST",
        json: payload,
    });
}

export async function updateMt5Account(
    accountId: string,
    payload: Partial<Mt5AccountRecord> | Record<string, unknown>,
): Promise<Mt5AccountRecord> {
    return nestAuthFetch<Mt5AccountRecord>(`/api/mt5-accounts/${accountId}`, {
        method: "PATCH",
        json: payload,
    });
}

export async function deleteMt5Account(accountId: string): Promise<{ ok: boolean }> {
    return nestAuthFetch<{ ok: boolean }>(`/api/mt5-accounts/${accountId}`, {
        method: "DELETE",
    });
}

export async function connectMt5Account(
    accountId: string,
    attemptId?: number,
    options?: { async?: boolean },
): Promise<{
    ok: boolean;
    status: string;
    message: string;
    balance: number | null;
    equity: number | null;
    checkedAt: string;
    status_label: string;
    retry_in_seconds?: number;
}> {
    return nestAuthFetch<{
        ok: boolean;
        status: string;
        message: string;
        balance: number | null;
        equity: number | null;
        checkedAt: string;
        status_label: string;
        retry_in_seconds?: number;
    }>(`/api/mt5-accounts/${accountId}/connect`, {
        method: "POST",
        json: { attemptId, async: options?.async === true },
    });
}

export interface Mt5SlotsInfo {
    totalSlots: number;
    usedSlots: number;
    freeSlots: number;
    hasAvailability: boolean;
    maxAccountsPerUser?: number;
    isAdmin: boolean;
}

export async function getMt5SlotsInfo(): Promise<Mt5SlotsInfo> {
    return nestAuthFetch<Mt5SlotsInfo>("/api/mt5-accounts/slots-info");
}

export async function getRiskSettings(): Promise<UserRiskSettingsRecord> {
    return nestAuthFetch<UserRiskSettingsRecord>("/api/risk-settings/me");
}

export async function updateRiskSettings(
    payload: Partial<UserRiskSettingsRecord> | Record<string, unknown>,
): Promise<UserRiskSettingsRecord> {
    return nestAuthFetch<UserRiskSettingsRecord>("/api/risk-settings/me", {
        method: "PATCH",
        json: payload,
    });
}

export interface MarketSearchContentItem {
    id?: string;
    title?: string;
    description?: string;
    summary?: string;
    source?: string;
    url?: string;
    published_at?: string;
    tags?: string[];
    symbols?: string[];
}

export interface SearchMarketContentParams {
    market?: string;
    items: MarketSearchContentItem[];
    use_ai?: boolean;
    min_score?: number;
    max_queries?: number;
    ai_limit?: number;
    ai_timeout_ms?: number;
}

export interface SearchMarketContentResultItem {
    id: string | null;
    title: string;
    source: string | null;
    published_at: string | null;
    url: string | null;
    symbols: string[];
    tags: string[];
    score_rules: number;
    score_hybrid: number;
    matched_tickers: string[];
    matched_hashtags: string[];
    matched_phrases: string[];
    matched_symbols: string[];
    ai: {
        relevance: number;
        label: "relevant" | "partial" | "irrelevant";
        reason: string;
    } | null;
}

export interface SearchMarketContentResult {
    market: string;
    label: string;
    query_pack: string[];
    filters: {
        min_score: number;
        use_ai: boolean;
        ai_limit: number;
        ai_timeout_ms: number;
    };
    stats: {
        user_id: string;
        total_items: number;
        ai_scored_items: number;
        matched_items: number;
    };
    items: SearchMarketContentResultItem[];
}

export async function searchMarketContent(
    payload: SearchMarketContentParams,
): Promise<SearchMarketContentResult> {
    return nestAuthFetch<SearchMarketContentResult>("/api/functions/market-content/search", {
        method: "POST",
        json: payload,
    });
}
