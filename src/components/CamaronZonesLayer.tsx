import { useEffect, useRef, useState } from "react";
import { PolygonType } from "klinecharts";

import { nestAuthFetch } from "@/api/client";
import { getActiveProChart } from "@/lib/chartPro/chartInstance";
import { isCamaronZonesOn, onCamaronZonesChange, setCamaronZonesStatus } from "@/lib/pine/systemScripts";

// Capa HEADLESS de zonas del Camarón: cuando el script de sistema "CAMARÓN ·
// zonas en vivo" está añadido al chart (panel Pine), dibuja las zonas REALES
// del motor (telemetría) refrescándose cada 15s. Independiente del HUD de
// Configuración — esta capa solo pinta zonas, sin caja de texto.

const POLL_MS = 15_000;
const HUD_MIN_KEY = "kai:camaron:hud-min";

interface Zone {
  high: number | null;
  low: number | null;
  type: "supply" | "demand";
  /** Origen de la zona (ms) — la caja nace aquí, como TradingView. */
  time?: number | null;
}

interface CamState {
  signal: string;
  reason: string;
  zones: Zone[];
}

// Traducción AMIGABLE (sin jerga) de lo que el Camarón está haciendo.
function friendlyStatus(cam: CamState): string {
  const r = cam.reason.toLowerCase();
  if (cam.signal === "BUY") return "¡Entró en COMPRA! El precio tocó una zona verde y rebotó con fuerza.";
  if (cam.signal === "SELL") return "¡Entró en VENTA! El precio tocó una zona roja y rebotó con fuerza.";
  if (/cupo|budget|agotad/.test(r)) return "Ya hizo su operación de esta sesión. Descansando hasta la próxima.";
  if (/cooldown|enfriam/.test(r)) return "Acaba de operar. Se toma una pausa corta antes de buscar otra entrada.";
  if (/noticia/.test(r)) return "Hay noticias importantes ahora mismo. Prefiere esperar a que pase el ruido.";
  if (/fuera de sesión|mercado cerrado|horario/.test(r)) return "El mercado está fuera de su horario. Esperando a que abra la sesión.";
  if (/riesgo|drawdown|límite|racha/.test(r)) return "Por seguridad ya no arriesga más hoy. Mañana sigue.";
  if (cam.zones.length > 0) return "Vigilando. Espera que el precio llegue a una de las zonas pintadas y rebote.";
  return "Estudiando el gráfico. Aún no encuentra zonas claras donde valga la pena entrar.";
}

// Checklist simple de confirmaciones (✓ = ya se cumplió).
function confirmations(cam: CamState): Array<{ label: string; ok: boolean }> {
  const r = cam.reason.toLowerCase();
  const blocked = /cupo|budget|agotad|cooldown|enfriam|noticia|fuera de sesión|mercado cerrado|riesgo|drawdown|límite|racha/.test(r);
  const entered = cam.signal === "BUY" || cam.signal === "SELL";
  return [
    { label: "Zonas pintadas en el gráfico", ok: cam.zones.length > 0 },
    { label: "El precio toca una zona y rebota", ok: entered },
    { label: "Luz verde (horario y riesgo)", ok: entered || !blocked },
  ];
}

function telemetryRoot(symbol: string): string {
  // MISMA regla que telemetrySymbolRoot del backend: fuera sufijo de escala
  // (_x100m) y sufijo de bróker en minúscula (USTECm→USTEC, BTCUSDm→BTCUSD).
  let s = symbol.trim().replace(/_x\d+m?$/i, "");
  if (/[a-z]$/.test(s) && s.length > 3) s = s.slice(0, -1);
  return s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

export function CamaronZonesLayer({ symbol }: { symbol: string | null }) {
  const [on, setOn] = useState<boolean>(() => isCamaronZonesOn());
  const [zones, setZones] = useState<Zone[]>([]);
  const [cam, setCam] = useState<CamState | null>(null);
  const [minimized, setMinimized] = useState<boolean>(() => {
    try {
      return localStorage.getItem(HUD_MIN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const idsRef = useRef<string[]>([]);

  const toggleMin = () => {
    setMinimized((m) => {
      try {
        localStorage.setItem(HUD_MIN_KEY, m ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !m;
    });
  };

  useEffect(() => onCamaronZonesChange(() => setOn(isCamaronZonesOn())), []);

  // Poll de zonas del motor
  useEffect(() => {
    if (!on || !symbol) {
      setZones([]);
      setCam(null);
      return;
    }
    let alive = true;
    const root = telemetryRoot(symbol);
    const tick = async () => {
      try {
        const res = await nestAuthFetch<{
          available: boolean;
          snapshot?: { results: Array<{ strategy?: string; signal?: string; reason?: string; zones?: Zone[] }> };
        }>(`/api/admin/strategy-telemetry?symbol=${encodeURIComponent(root)}`);
        if (!alive) return;
        const results = res?.available ? (res.snapshot?.results ?? []) : [];
        const zs = results.find((r) => Array.isArray(r.zones))?.zones ?? [];
        setZones(zs);
        const camRes = results.find((r) => r.strategy === "CAMARON");
        setCam(
          camRes
            ? { signal: String(camRes.signal ?? "HOLD"), reason: String(camRes.reason ?? ""), zones: zs }
            : null,
        );
        setCamaronZonesStatus(root, Boolean(res?.available));
      } catch {
        if (alive) {
          setZones([]);
          setCam(null);
          setCamaronZonesStatus(root, false);
        }
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [on, symbol]);

  // Dibujo/limpieza de rectángulos
  useEffect(() => {
    const chart = getActiveProChart();
    if (!chart) return;
    for (const id of idsRef.current) {
      try {
        chart.removeOverlay({ id });
      } catch {
        /* ya no existe */
      }
    }
    idsRef.current = [];
    if (!on || zones.length === 0) return;
    const data = chart.getDataList?.() ?? [];
    if (data.length < 2) return;
    const tEnd = data[data.length - 1].timestamp;
    const fallbackStart = data[Math.max(0, data.length - 90)].timestamp;
    const firstLoaded = data[0].timestamp;
    zones.forEach((z, idx) => {
      if (z.high == null || z.low == null) return;
      const supply = z.type === "supply";
      // La caja NACE donde se formó la zona (feedback: sin origen "flotaban");
      // si el origen quedó fuera del histórico cargado, se ancla al inicio.
      const origin = z.time != null && Number.isFinite(z.time) ? Math.max(firstLoaded, Math.min(z.time, tEnd)) : fallbackStart;
      const id = `kai-camzone-${idx}`;
      try {
        chart.createOverlay({
          name: "rect",
          id,
          groupId: "kai_camaron_zones",
          lock: true,
          points: [
            { timestamp: origin, value: z.high },
            { timestamp: tEnd, value: z.low },
          ],
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
        idsRef.current.push(id);
      } catch {
        /* overlay no disponible */
      }
    });
    return () => {
      const c = getActiveProChart();
      if (!c) return;
      for (const id of idsRef.current) {
        try {
          c.removeOverlay({ id });
        } catch {
          /* ignore */
        }
      }
      idsRef.current = [];
    };
  }, [on, zones]);

  // El aviso "el motor no evalúa X" vive en el panel Pine; aquí solo se muestra
  // el mini-HUD amigable cuando SÍ hay telemetría del Camarón para el símbolo.
  if (!on || !cam) return null;

  const entered = cam.signal === "BUY" || cam.signal === "SELL";

  if (minimized) {
    return (
      <button
        onClick={toggleMin}
        title="Camarón — ver estado"
        className="absolute top-2 right-20 z-20 h-7 w-7 rounded-full bg-black/60 backdrop-blur border border-white/10 text-[13px] leading-none flex items-center justify-center hover:bg-black/80"
      >
        🦐
      </button>
    );
  }

  return (
    <div className="absolute top-2 right-20 z-20 w-[210px] rounded-lg bg-black/60 backdrop-blur border border-white/10 text-white/90 shadow-lg select-none">
      <button onClick={toggleMin} className="w-full flex items-center gap-1.5 px-2.5 pt-2 text-left" title="Minimizar">
        <span className="text-[12px]">🦐</span>
        <span className="text-[10px] font-semibold tracking-wide text-white/70">CAMARÓN</span>
        <span
          className={`ml-auto h-1.5 w-1.5 rounded-full ${entered ? "bg-emerald-400 animate-pulse" : "bg-amber-300/80"}`}
        />
      </button>
      <div className="px-2.5 pt-1 text-[10.5px] leading-snug text-white/80">{friendlyStatus(cam)}</div>
      <div className="px-2.5 pb-2 pt-1.5 space-y-0.5">
        {confirmations(cam).map((c) => (
          <div key={c.label} className="flex items-center gap-1.5 text-[10px] leading-tight">
            <span className={c.ok ? "text-emerald-400" : "text-white/30"}>{c.ok ? "✓" : "○"}</span>
            <span className={c.ok ? "text-white/75" : "text-white/45"}>{c.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
