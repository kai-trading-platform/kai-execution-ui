import { useEffect, useMemo, useState } from "react";
import { Bell, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatSymbolDisplay } from "@/lib/symbolDisplay";
import type { PriceAlert, TriggeredAlert } from "@/hooks/usePriceAlerts";

function dec(p: number) {
  return p > 0 && p < 20 ? 5 : 2;
}

export function AlertsDialog({
  open,
  onOpenChange,
  symbols,
  defaultSymbol,
  getPrice,
  alerts,
  triggered,
  onAdd,
  onRemove,
  onClearTriggered,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  symbols: Array<{ name: string; display: string }>;
  defaultSymbol: string;
  getPrice: (symbol: string) => number | null;
  alerts: PriceAlert[];
  triggered: TriggeredAlert[];
  onAdd: (symbol: string, target: number) => void;
  onRemove: (id: string) => void;
  onClearTriggered: () => void;
}) {
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [price, setPrice] = useState("");

  // Keep the form's symbol in sync with the chart selection when reopened.
  useEffect(() => {
    if (open && defaultSymbol) setSymbol(defaultSymbol);
  }, [open, defaultSymbol]);

  const current = getPrice(symbol);
  const targetNum = parseFloat(price);
  const direction = current != null && targetNum >= current ? "up" : "down";

  const sortedSymbols = useMemo(() => symbols.slice(0, 60), [symbols]);

  const submit = () => {
    if (!symbol || !Number.isFinite(targetNum) || targetNum <= 0) return;
    onAdd(symbol, targetNum);
    setPrice("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-white/10 bg-[#0d0f16] text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-[#2f6bff]" /> Alertas de precio
          </DialogTitle>
          <DialogDescription className="sr-only">
            Crea y gestiona alertas que te avisan cuando un símbolo alcanza un precio.
          </DialogDescription>
        </DialogHeader>

        {/* Create */}
        <div className="rounded-lg border border-white/10 bg-[#151824] p-3 space-y-2">
          <div className="text-[10px] uppercase tracking-wider text-white/45">Nueva alerta</div>
          <div className="flex gap-2">
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="h-9 flex-1 rounded-md border border-white/10 bg-[#0d0f16] px-2 text-xs text-white outline-none focus:border-[#2f6bff]"
            >
              {sortedSymbols.map((s) => (
                <option key={s.name} value={s.name}>{s.display}</option>
              ))}
            </select>
            <Input
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Precio"
              className="h-9 w-28 bg-[#0d0f16] border-white/10 text-white tabular-nums"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] text-white/45">
              {current != null ? (
                <>Actual <span className="tabular-nums text-white/70">{current.toFixed(dec(current))}</span>
                  {Number.isFinite(targetNum) && targetNum > 0 && (
                    <span className={cn("ml-2", direction === "up" ? "text-[#2ed68d]" : "text-[#ef5350]")}>
                      {direction === "up" ? "▲ cuando suba" : "▼ cuando baje"}
                    </span>
                  )}
                </>
              ) : "Sin precio en vivo para este símbolo"}
            </span>
            <Button size="sm" className="h-7 bg-[#2f6bff] hover:bg-[#3a64b8] text-white" onClick={submit}>
              Crear
            </Button>
          </div>
        </div>

        {/* Active alerts */}
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-wider text-white/45">Activas ({alerts.length})</div>
          {alerts.length === 0 && <p className="text-xs text-white/40 py-1">No tienes alertas activas.</p>}
          {alerts.map((a) => (
            <div key={a.id} className="flex items-center justify-between rounded-md border border-white/10 bg-[#151824] px-3 py-2">
              <div className="flex items-center gap-2 text-xs">
                {a.direction === "up" ? <ArrowUp className="h-3.5 w-3.5 text-[#2ed68d]" /> : <ArrowDown className="h-3.5 w-3.5 text-[#ef5350]" />}
                <span className="font-semibold">{formatSymbolDisplay(a.symbol)}</span>
                <span className="text-white/50">{a.direction === "up" ? "≥" : "≤"}</span>
                <span className="tabular-nums">{a.target.toFixed(dec(a.target))}</span>
              </div>
              <button onClick={() => onRemove(a.id)} className="text-white/40 hover:text-[#ef5350]" aria-label="Eliminar alerta">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>

        {/* Triggered history */}
        {triggered.length > 0 && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-white/45">Disparadas ({triggered.length})</span>
              <button onClick={onClearTriggered} className="text-[10px] text-white/40 hover:text-white">Limpiar</button>
            </div>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {triggered.map((t) => (
                <div key={t.id} className="flex items-center justify-between rounded-md bg-[#2f6bff]/10 px-3 py-1.5 text-xs">
                  <span className="flex items-center gap-2">
                    <Bell className="h-3 w-3 text-[#2f6bff]" />
                    <span className="font-semibold">{formatSymbolDisplay(t.symbol)}</span>
                    <span className="text-white/50">alcanzó</span>
                    <span className="tabular-nums">{t.target.toFixed(dec(t.target))}</span>
                  </span>
                  <span className="tabular-nums text-white/40">{new Date(t.triggeredAt).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
