import { useEffect, useRef, useState } from "react";
import { PolygonType } from "klinecharts";
import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { nestAuthFetch } from "@/api/client";
import { getActiveProChart } from "@/lib/chartPro/chartInstance";

// HUD de telemetría de estrategias (SOLO admin): caja de texto sobre el chart
// con lo que cada estrategia viva está esperando/haciendo (reason del último
// ciclo de evaluación del worker) + las zonas supply/demand del Camarón
// dibujadas como rectángulos. Datos del endpoint admin/strategy-telemetry
// (Redis, publicado por analyze-signals en cada vela evaluada).

interface TelemetryResult {
  strategy: string;
  signal: "BUY" | "SELL" | "HOLD";
  confidence: number;
  reason: string;
  setup: { entry: number | null; stopLoss: number | null; takeProfit: number | null } | null;
  zones?: Array<{ high: number | null; low: number | null; type: "supply" | "demand" }>;
}

interface TelemetrySnapshot {
  symbol: string;
  at: number;
  price: number | null;
  winner: string | null;
  results: TelemetryResult[];
}

const POLL_MS = 10_000;
const ZONES_GROUP = "kai_strategy_zones";

/** Root del símbolo del chart → símbolo del motor (MNQ, USTEC_x100m → USTEC…). */
function telemetryRoot(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/_X\d+M?$/i, "")
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

export function StrategyTelemetryBox({ symbol, onClose }: { symbol: string | null; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<TelemetrySnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const zoneIdsRef = useRef<string[]>([]);

  // Poll del snapshot
  useEffect(() => {
    if (!symbol) return;
    let alive = true;
    const root = telemetryRoot(symbol);
    const tick = async () => {
      try {
        const res = await nestAuthFetch<{ available: boolean; snapshot?: TelemetrySnapshot }>(
          `/api/admin/strategy-telemetry?symbol=${encodeURIComponent(root)}`,
        );
        if (!alive) return;
        if (res?.available && res.snapshot) {
          setSnapshot(res.snapshot);
          setUnavailable(false);
        } else {
          setUnavailable(true);
        }
      } catch {
        if (alive) setUnavailable(true);
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [symbol]);

  // Zonas del Camarón como rectángulos supply/demand en el chart.
  useEffect(() => {
    const chart = getActiveProChart();
    if (!chart) return;
    // limpiar las anteriores
    for (const id of zoneIdsRef.current) {
      try {
        chart.removeOverlay({ id });
      } catch {
        /* ya no existe */
      }
    }
    zoneIdsRef.current = [];
    if (!snapshot) return;
    const zones = snapshot.results.find((r) => Array.isArray(r.zones))?.zones ?? [];
    if (zones.length === 0) return;
    const data = chart.getDataList?.() ?? [];
    if (data.length < 2) return;
    const tEnd = data[data.length - 1].timestamp;
    const tStart = data[Math.max(0, data.length - 90)].timestamp;
    zones.forEach((z, idx) => {
      if (z.high == null || z.low == null) return;
      const supply = z.type === "supply";
      const id = `kai-zone-${idx}`;
      try {
        chart.createOverlay({
          name: "rect",
          id,
          groupId: ZONES_GROUP,
          lock: true,
          points: [
            { timestamp: tStart, value: z.high },
            { timestamp: tEnd, value: z.low },
          ],
          // El overlay 'rect' builtin lee styles.rect y su figura interna es un
          // polygon: se pasan AMBAS claves para cubrir versiones del fork.
          styles: {
            rect: {
              style: PolygonType.StrokeFill,
              color: supply ? "rgba(239,83,80,0.08)" : "rgba(46,214,141,0.08)",
              borderColor: supply ? "rgba(239,83,80,0.35)" : "rgba(46,214,141,0.35)",
              borderSize: 1,
            },
            polygon: {
              style: PolygonType.StrokeFill,
              color: supply ? "rgba(239,83,80,0.08)" : "rgba(46,214,141,0.08)",
              borderColor: supply ? "rgba(239,83,80,0.35)" : "rgba(46,214,141,0.35)",
              borderSize: 1,
            },
          },
        });
        zoneIdsRef.current.push(id);
      } catch {
        /* overlay no soportado → sin zonas */
      }
    });
    return () => {
      const c = getActiveProChart();
      if (!c) return;
      for (const id of zoneIdsRef.current) {
        try {
          c.removeOverlay({ id });
        } catch {
          /* ignore */
        }
      }
      zoneIdsRef.current = [];
    };
  }, [snapshot]);

  const ageSec = snapshot ? Math.max(0, Math.round((Date.now() - snapshot.at) / 1000)) : null;

  return (
    <div className="absolute top-12 left-2 z-20 w-[300px] max-w-[70vw] rounded-md border border-white/10 bg-[#0d0f16]/90 backdrop-blur-sm shadow-xl text-[10px]">
      <div className="flex items-center gap-2 px-2.5 py-1.5 border-b border-white/10">
        <span className="font-semibold text-white/80 uppercase tracking-wide">Estrategias · {symbol ? telemetryRoot(symbol) : "—"}</span>
        {ageSec != null && <span className="text-white/35">hace {ageSec}s</span>}
        <button type="button" onClick={onClose} className="ml-auto text-white/40 hover:text-white/80" aria-label="Cerrar telemetría">
          <X className="h-3 w-3" />
        </button>
      </div>
      {unavailable && (
        <div className="px-2.5 py-2 text-white/45">
          Sin telemetría para este símbolo (el motor evalúa MNQ y los símbolos configurados; llega tras la próxima vela evaluada).
        </div>
      )}
      {snapshot && (
        <div className="px-2.5 py-1.5 space-y-1.5 max-h-56 overflow-y-auto">
          {snapshot.results.map((r) => (
            <div key={r.strategy} className={cn("rounded border border-white/5 px-2 py-1", snapshot.winner === r.strategy && "border-[#2f6bff]/40 bg-[#2f6bff]/5")}>
              <div className="flex items-center gap-2">
                <span className="font-semibold text-white/85">{r.strategy}</span>
                <span
                  className={cn(
                    "px-1 rounded text-[9px] font-bold",
                    r.signal === "BUY" && "bg-emerald-500/15 text-emerald-400",
                    r.signal === "SELL" && "bg-red-500/15 text-red-400",
                    r.signal === "HOLD" && "bg-white/5 text-white/40",
                  )}
                >
                  {r.signal}
                </span>
                <span className="text-white/35">{Math.round(r.confidence)}%</span>
                {snapshot.winner === r.strategy && <span className="text-[9px] text-[#7ea6ff]">ganadora</span>}
              </div>
              <div className="text-white/55 leading-snug mt-0.5">{r.reason || "—"}</div>
              {r.setup && r.setup.entry != null && (
                <div className="text-white/40 font-mono mt-0.5">
                  entry {r.setup.entry} · SL {r.setup.stopLoss ?? "—"} · TP {r.setup.takeProfit ?? "—"}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {!snapshot && !unavailable && <div className="px-2.5 py-2 text-white/40">Cargando telemetría…</div>}
    </div>
  );
}
