import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { closeTradingPosition, closeTradingPositionBy } from "@/api/trading";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { REAL_CONFIRMATION_TEXT } from "@/constants/tradingExecution";
import { tradingPositionsQueryKey, useTradingPositions } from "@/hooks/useTradingPositions";
import type { CopyTradingPosition } from "@/modules/copyTrading/types";
import { tradingPositionsToCopyPositions } from "@/utils/tradingPositionAdapter";
import { cn } from "@/lib/utils";

interface PositionsPanelProps {
  accountId: string | null;
  className?: string;
}

type PositionTab = "open" | "pending" | "history";
type CloseScope = "all" | "profitable" | "losing" | "buy" | "sell";
type SingleCloseTab = "market" | "partial" | "closeBy";

function formatCurrency(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatNumber(value: number | null | undefined, decimals = 2): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatVolumeInput(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "";
  return value.toFixed(2);
}

function formatSignedAmount(value: number | null | undefined): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value >= 0 ? "+" : "-"}${abs}`;
}

function sumPnl(positions: CopyTradingPosition[]): number {
  return positions.reduce((sum, position) => sum + (Number(position.openPnlUsd) || 0), 0);
}

function positionsForScope(positions: CopyTradingPosition[], scope: CloseScope): CopyTradingPosition[] {
  if (scope === "profitable") return positions.filter((position) => position.openPnlUsd > 0);
  if (scope === "losing") return positions.filter((position) => position.openPnlUsd < 0);
  if (scope === "buy") return positions.filter((position) => position.side === "LONG");
  if (scope === "sell") return positions.filter((position) => position.side === "SHORT");
  return positions;
}

function getCloseErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const maybeMessage = "userMessage" in error ? error.userMessage : "message" in error ? error.message : null;
    if (typeof maybeMessage === "string" && maybeMessage.trim()) return maybeMessage;
  }
  return "No se pudo cerrar la posición.";
}

interface PositionsTableProps {
  positions: CopyTradingPosition[];
  onClosePosition?: (position: CopyTradingPosition) => void;
}

function PositionsTable({ positions, onClosePosition }: PositionsTableProps) {
  if (positions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[11px] text-[#6b7280]">
        Sin posiciones abiertas
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto" style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(107,114,128,0.2) transparent" }}>
      <table className="min-w-[1040px] w-full table-fixed">
        <thead className="sticky top-0 z-10 bg-[#071321]">
          <tr className="border-b border-[#12364b]/70">
            <th className="px-2 py-1.5 text-left text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7280]">Ticket</th>
            <th className="px-2 py-1.5 text-left text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7280]">Símbolo</th>
            <th className="px-2 py-1.5 text-left text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7280]">Tipo</th>
            <th className="px-2 py-1.5 text-right text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7280]">Volumen</th>
            <th className="px-2 py-1.5 text-right text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7280]">Precio de entrada</th>
            <th className="px-2 py-1.5 text-right text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7280]">Precio actual</th>
            <th className="px-2 py-1.5 text-right text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7280]">TP</th>
            <th className="px-2 py-1.5 text-right text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7280]">SL</th>
            <th className="px-2 py-1.5 text-right text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7280]">Swap</th>
            <th className="px-2 py-1.5 text-right text-[9px] font-bold uppercase tracking-[0.1em] text-[#6b7280]">P&amp;L</th>
            <th className="w-[32px] px-1 py-1.5" />
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => {
            const isLong = position.side === "LONG";
            const pnl = position.openPnlUsd;
            const pnlColor = pnl >= 0 ? "text-[#00c076]" : "text-[#ff3b30]";

            return (
              <tr
                key={position.id}
                onClick={() => onClosePosition?.(position)}
                className="h-8 cursor-pointer border-b border-[#12364b]/35 transition-colors hover:bg-[#0b2234]/50"
              >
                <td className="px-2 py-1.5 font-mono text-[11px] text-[#8fa1aa] tabular-nums">#{position.id || "—"}</td>
                <td className="px-2 py-1.5 text-[11px] font-medium text-[#e2e4e9]">{position.symbol || "—"}</td>
                <td className="px-2 py-1.5">
                  <span className={cn(
                    "inline-flex rounded px-1 py-0.5 text-[9px] font-bold",
                    isLong
                      ? "bg-[#00c076]/10 text-[#00c076]"
                      : "bg-[#ff3b30]/10 text-[#ff3b30]"
                  )}>
                    {isLong ? "BUY" : "SELL"}
                  </span>
                </td>
                <td className="px-2 py-1.5 text-right font-mono text-[11px] text-[#6b7280] tabular-nums">{formatNumber(position.qty)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-[11px] text-[#6b7280] tabular-nums">{formatNumber(position.avgPrice)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-[11px] text-[#6b7280] tabular-nums">{formatNumber(position.currentPrice)}</td>
                <td className="px-2 py-1.5 text-right font-mono text-[11px] text-[#00c076] tabular-nums">{position.tp ? formatNumber(position.tp) : "—"}</td>
                <td className="px-2 py-1.5 text-right font-mono text-[11px] text-[#ff3b30] tabular-nums">{position.sl ? formatNumber(position.sl) : "—"}</td>
                <td className="px-2 py-1.5 text-right font-mono text-[11px] text-[#8fa1aa] tabular-nums">—</td>
                <td className={cn("px-2 py-1.5 text-right font-mono text-[11px] font-semibold tabular-nums", pnlColor)}>
                  {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}
                </td>
                <td className="px-1 py-1.5 text-right">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onClosePosition?.(position);
                    }}
                    disabled={!onClosePosition}
                    className="flex h-6 w-6 items-center justify-center rounded text-[#6b7280] transition-colors hover:bg-[#ff3b30]/10 hover:text-[#ff3b30] disabled:cursor-not-allowed disabled:opacity-40"
                    title="Cerrar"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CloseOptionButton({
  label,
  count,
  pnl,
  loading,
  disabled,
  onClick,
}: {
  label: string;
  count: number;
  pnl: number;
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const hasPositions = count > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || !hasPositions}
      className={cn(
        "grid w-full grid-cols-[1fr_44px_88px] items-center gap-3 rounded border border-[#12364b]/70 bg-[#071321] px-3 py-3 text-left transition-colors",
        hasPositions
          ? "hover:border-[#ff3b30]/40 hover:bg-[#0b2234]"
          : "cursor-not-allowed opacity-45",
        disabled && "cursor-wait"
      )}
    >
      <span className="min-w-0 text-[13px] font-semibold text-[#e2e4e9]">{label}</span>
      <span className="text-center font-mono text-[13px] font-semibold text-[#f7fbff] tabular-nums">
        {loading ? <Loader2 className="mx-auto h-4 w-4 animate-spin text-[#ff3b30]" /> : hasPositions ? count : "--"}
      </span>
      <span className={cn(
        "text-right font-mono text-[13px] font-semibold tabular-nums",
        !hasPositions ? "text-[#6b7280]" : pnl >= 0 ? "text-[#00c076]" : "text-[#ff3b30]"
      )}>
        {hasPositions ? formatSignedAmount(pnl) : "--"}
      </span>
    </button>
  );
}

export function PositionsPanel({ accountId, className }: PositionsPanelProps) {
  const [positionTab, setPositionTab] = useState<PositionTab>("open");
  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [singlePositionToClose, setSinglePositionToClose] = useState<CopyTradingPosition | null>(null);
  const [singleCloseTab, setSingleCloseTab] = useState<SingleCloseTab>("market");
  const [partialVolume, setPartialVolume] = useState("");
  const [closeByTicket, setCloseByTicket] = useState("");
  const [selectedBulkScope, setSelectedBulkScope] = useState<CloseScope>("all");
  const [closingKey, setClosingKey] = useState<CloseScope | "single" | "partial" | "closeBy" | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { data: tradingPositions = [], isLoading } = useTradingPositions(accountId);

  const filteredPositions = useMemo(() => {
    if (!accountId) return [];
    return tradingPositionsToCopyPositions(tradingPositions);
  }, [tradingPositions, accountId]);

  const tabs: Array<{ id: PositionTab; label: string }> = [
    { id: "open", label: `POSICIONES (${filteredPositions.length})` },
    { id: "pending", label: "ÓRDENES" },
    { id: "history", label: "HISTORIAL" },
  ];

  const closeOptions = useMemo(
    () => [
      { scope: "all" as const, label: "Cerrar todas", positions: positionsForScope(filteredPositions, "all") },
      { scope: "profitable" as const, label: "Cerrar todas las rentables", positions: positionsForScope(filteredPositions, "profitable") },
      { scope: "losing" as const, label: "Cerrar todas las perdedoras", positions: positionsForScope(filteredPositions, "losing") },
      { scope: "buy" as const, label: "Cerrar todas las de compra", positions: positionsForScope(filteredPositions, "buy") },
      { scope: "sell" as const, label: "Cerrar todas las de venta", positions: positionsForScope(filteredPositions, "sell") },
    ],
    [filteredPositions],
  );

  const openBulkCloseModal = () => {
    setSinglePositionToClose(null);
    setSelectedBulkScope("all");
    setCloseError(null);
    setCloseModalOpen(true);
  };

  const openSingleCloseModal = (position: CopyTradingPosition) => {
    setSinglePositionToClose(position);
    setSingleCloseTab("market");
    setPartialVolume(formatVolumeInput(Number(position.qty || 0) / 2));
    setCloseByTicket("");
    setCloseError(null);
    setCloseModalOpen(true);
  };

  const invalidatePositionData = async (targetPositions: CopyTradingPosition[]) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["trading-sessions"] }),
      ...Array.from(new Set(targetPositions.map((position) => position.accountId))).map((id) =>
        queryClient.invalidateQueries({ queryKey: tradingPositionsQueryKey(id) }),
      ),
    ]);
  };

  const closePositions = async (
    targetPositions: CopyTradingPosition[],
    key: CloseScope | "single" | "partial",
    volume?: number | null,
  ) => {
    if (targetPositions.length === 0) return;

    setClosingKey(key);
    setCloseError(null);

    const failures: string[] = [];
    let closedCount = 0;

    for (const position of targetPositions) {
      const ticket = String(position.id || "").trim();
      if (!ticket) {
        failures.push(`${position.symbol}: ticket vacío`);
        continue;
      }

      try {
        await closeTradingPosition({
          tradingAccountId: position.accountId,
          ticket,
          volume: volume ?? undefined,
          dryRun: false,
          confirmationText: REAL_CONFIRMATION_TEXT,
        });
        closedCount += 1;
      } catch (error) {
        failures.push(`${position.symbol} #${ticket}: ${getCloseErrorMessage(error)}`);
      }
    }

    await invalidatePositionData(targetPositions);
    setClosingKey(null);

    if (failures.length === 0) {
      const realizedPnl = sumPnl(targetPositions);
      toast.success(closedCount === 1 ? "Posición cerrada" : `${closedCount} posiciones cerradas`, {
        description: `P&L estimado: ${formatSignedAmount(realizedPnl)}`,
      });
      setCloseModalOpen(false);
      setSinglePositionToClose(null);
      return;
    }

    const message = failures.slice(0, 2).join(" · ");
    setCloseError(message);
    toast.error(`No se cerraron ${failures.length} de ${targetPositions.length} posiciones`, {
      description: message,
    });
  };

  const closeByPosition = async (position: CopyTradingPosition, byTicket: string) => {
    const ticket = String(position.id || "").trim();
    const pair = filteredPositions.find((row) => String(row.id) === byTicket) ?? null;
    if (!ticket || !pair) return;

    setClosingKey("closeBy");
    setCloseError(null);
    try {
      await closeTradingPositionBy({
        tradingAccountId: position.accountId,
        ticket,
        byTicket,
        dryRun: false,
        confirmationText: REAL_CONFIRMATION_TEXT,
      });
      await invalidatePositionData([position, pair]);
      toast.success("Posiciones cerradas por opuesta", {
        description: `${position.symbol} #${ticket} contra #${byTicket}`,
      });
      setCloseModalOpen(false);
      setSinglePositionToClose(null);
    } catch (error) {
      const message = getCloseErrorMessage(error);
      setCloseError(message);
      toast.error("No se pudo ejecutar Cerrar por", { description: message });
    } finally {
      setClosingKey(null);
    }
  };

  const modalBusy = closingKey !== null;
  const selectedBulkOption = closeOptions.find((option) => option.scope === selectedBulkScope) ?? closeOptions[0];
  const closeByCandidates = singlePositionToClose
    ? filteredPositions.filter(
        (position) =>
          position.id !== singlePositionToClose.id &&
          position.symbol === singlePositionToClose.symbol &&
          position.side !== singlePositionToClose.side,
      )
    : [];
  const parsedPartialVolume = Number(partialVolume);
  const canPartialClose = Boolean(
    singlePositionToClose &&
      Number.isFinite(parsedPartialVolume) &&
      parsedPartialVolume > 0 &&
      parsedPartialVolume < Number(singlePositionToClose.qty || 0),
  );

  return (
    <div className={cn("flex h-full min-h-0 flex-col overflow-hidden bg-[#071321]", className)}>
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[#12364b]/70 bg-[#061727] px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setPositionTab(tab.id)}
              className={cn(
                "rounded px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.06em] transition-colors",
                positionTab === tab.id
                  ? "bg-[#00c076]/15 text-[#00c076] ring-1 ring-[#00c076]/30"
                  : "text-[#6b7280] hover:bg-[#0b2234] hover:text-[#e2e4e9]"
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {positionTab === "open" && filteredPositions.length > 0 && (
          <button
            type="button"
            onClick={openBulkCloseModal}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded border border-[#ff3b30]/35 bg-[#ff3b30]/10 px-3 text-[10px] font-bold uppercase tracking-[0.08em] text-[#ff6b63] transition-colors hover:bg-[#ff3b30]/20"
          >
            <X className="h-3 w-3" />
            Cerrar todo
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 bg-[#071321]">
        {isLoading ? (
          <div className="flex h-full items-center justify-center text-[11px] text-[#6b7280]">Cargando...</div>
        ) : positionTab === "open" ? (
          <PositionsTable positions={filteredPositions} onClosePosition={openSingleCloseModal} />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] text-[#6b7280]">
            {positionTab === "pending" ? "Sin órdenes pendientes" : "Sin historial disponible"}
          </div>
        )}
      </div>

      <Dialog open={closeModalOpen} onOpenChange={(open) => {
        if (modalBusy) return;
        setCloseModalOpen(open);
        if (!open) {
          setSinglePositionToClose(null);
          setCloseError(null);
        }
      }}>
        <DialogContent
          className="w-[calc(100vw-24px)] max-w-[460px] gap-4 border-[#12364b]/80 bg-[#061727] p-4 text-[#e2e4e9] shadow-2xl sm:p-5"
        >
          <DialogHeader className="space-y-2 text-left">
            <DialogTitle className="text-[17px] font-semibold text-[#f7fbff]">
              {singlePositionToClose
                ? "Gestionar posición abierta"
                : "Cerrar posiciones"}
            </DialogTitle>
            <DialogDescription className="text-[12px] leading-relaxed text-[#8fa1aa]">
              La solicitud se enviará al servidor y se ejecutará contra MT5. Los precios finales dependen del mercado.
            </DialogDescription>
          </DialogHeader>

          {singlePositionToClose ? (
            <div className="space-y-3">
              <div className="rounded border border-[#12364b]/70 bg-[#071321] p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-[#f7fbff]">
                      {singlePositionToClose.symbol} #{singlePositionToClose.id}
                    </p>
                    <p className="mt-1 text-[11px] uppercase tracking-[0.08em] text-[#8fa1aa]">
                      {singlePositionToClose.side === "LONG" ? "Compra" : "Venta"} · {formatNumber(singlePositionToClose.qty)} lotes
                    </p>
                  </div>
                  <div className={cn(
                    "font-mono text-[14px] font-semibold tabular-nums",
                    singlePositionToClose.openPnlUsd >= 0 ? "text-[#00c076]" : "text-[#ff3b30]"
                  )}>
                    {formatSignedAmount(singlePositionToClose.openPnlUsd)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-1 rounded border border-[#12364b]/70 bg-[#071321] p-1">
                {([
                  ["market", "Cerrar orden"],
                  ["partial", "Cierre parcial"],
                  ["closeBy", "Cerrar por"],
                ] as const).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setSingleCloseTab(tab)}
                    className={cn(
                      "rounded px-2 py-2 text-[10px] font-bold uppercase tracking-[0.05em] transition-colors",
                      singleCloseTab === tab
                        ? "bg-[#00c076]/15 text-[#00c076] ring-1 ring-[#00c076]/25"
                        : "text-[#8fa1aa] hover:bg-[#0b2234] hover:text-[#e2e4e9]",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {singleCloseTab === "market" && (
                <div className="space-y-3">
                  <p className="rounded border border-[#12364b]/70 bg-[#071321] p-3 text-[12px] leading-relaxed text-[#8fa1aa]">
                    Cierra el volumen completo a precio de mercado, sin recotizaciones.
                  </p>
                  <button
                    type="button"
                    onClick={() => void closePositions([singlePositionToClose], "single")}
                    disabled={modalBusy}
                    className="flex h-11 w-full items-center justify-center rounded bg-[#ff3b30] text-[13px] font-bold text-white transition-colors hover:bg-[#ff5252] disabled:cursor-wait disabled:opacity-60"
                  >
                    {closingKey === "single" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirmar cierre"}
                  </button>
                </div>
              )}

              {singleCloseTab === "partial" && (
                <div className="space-y-3">
                  <label className="block space-y-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#8fa1aa]">Volumen a cerrar</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={partialVolume}
                      onChange={(event) => setPartialVolume(event.target.value)}
                      className="h-10 w-full rounded border border-[#12364b]/70 bg-[#071321] px-3 text-right font-mono text-[13px] text-[#e2e4e9] outline-none focus:border-[#00c076]/50"
                    />
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {[0.25, 0.5, 0.75].map((ratio) => (
                      <button
                        key={ratio}
                        type="button"
                        onClick={() => setPartialVolume(formatVolumeInput(Number(singlePositionToClose.qty || 0) * ratio))}
                        className="h-8 rounded border border-[#12364b]/70 bg-[#071321] text-[11px] text-[#8fa1aa] transition-colors hover:border-[#00c076]/35 hover:text-[#00c076]"
                      >
                        {Math.round(ratio * 100)}%
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => void closePositions([singlePositionToClose], "partial", parsedPartialVolume)}
                    disabled={modalBusy || !canPartialClose}
                    className="flex h-11 w-full items-center justify-center rounded bg-[#ff3b30] text-[13px] font-bold text-white transition-colors hover:bg-[#ff5252] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {closingKey === "partial" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirmar cierre parcial"}
                  </button>
                </div>
              )}

              {singleCloseTab === "closeBy" && (
                <div className="space-y-3">
                  {closeByCandidates.length === 0 ? (
                    <p className="rounded border border-[#f5c542]/25 bg-[#f5c542]/10 p-3 text-[12px] text-[#f5c542]">
                      Necesitas una posición opuesta del mismo instrumento para usar Cerrar por.
                    </p>
                  ) : (
                    <>
                      <label className="block space-y-1.5">
                        <span className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#8fa1aa]">Posición opuesta</span>
                        <select
                          value={closeByTicket}
                          onChange={(event) => setCloseByTicket(event.target.value)}
                          className="h-10 w-full rounded border border-[#12364b]/70 bg-[#071321] px-3 text-[13px] text-[#e2e4e9] outline-none focus:border-[#00c076]/50"
                        >
                          <option value="">Selecciona una orden</option>
                          {closeByCandidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              #{candidate.id} · {candidate.side === "LONG" ? "BUY" : "SELL"} · {formatNumber(candidate.qty)} lotes · {formatSignedAmount(candidate.openPnlUsd)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        onClick={() => void closeByPosition(singlePositionToClose, closeByTicket)}
                        disabled={modalBusy || !closeByTicket}
                        className="flex h-11 w-full items-center justify-center rounded bg-[#ff3b30] text-[13px] font-bold text-white transition-colors hover:bg-[#ff5252] disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {closingKey === "closeBy" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Confirmar Cerrar por"}
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
              {closeOptions.map((option) => (
                <CloseOptionButton
                  key={option.scope}
                  label={option.label}
                  count={option.positions.length}
                  pnl={sumPnl(option.positions)}
                  loading={closingKey === option.scope}
                  disabled={modalBusy}
                  onClick={() => setSelectedBulkScope(option.scope)}
                />
              ))}
              </div>
              <button
                type="button"
                onClick={() => void closePositions(selectedBulkOption.positions, selectedBulkOption.scope)}
                disabled={modalBusy || selectedBulkOption.positions.length === 0}
                className="flex h-11 w-full items-center justify-center rounded bg-[#ff3b30] text-[13px] font-bold text-white transition-colors hover:bg-[#ff5252] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {closingKey === selectedBulkOption.scope ? <Loader2 className="h-4 w-4 animate-spin" /> : `Confirmar: ${selectedBulkOption.label}`}
              </button>
            </div>
          )}

          {closeError && (
            <div className="flex gap-2 rounded border border-[#ff3b30]/30 bg-[#ff3b30]/10 p-3 text-[12px] text-[#ffb0aa]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{closeError}</span>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
