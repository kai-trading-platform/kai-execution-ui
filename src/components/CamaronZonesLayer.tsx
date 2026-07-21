import { useEffect, useRef, useState } from "react";
import { PolygonType } from "klinecharts";

import { nestAuthFetch } from "@/api/client";
import { getActiveProChart } from "@/lib/chartPro/chartInstance";
import { isCamaronZonesOn, onCamaronZonesChange } from "@/lib/pine/systemScripts";

// Capa HEADLESS de zonas del Camarón: cuando el script de sistema "CAMARÓN ·
// zonas en vivo" está añadido al chart (panel Pine), dibuja las zonas REALES
// del motor (telemetría) refrescándose cada 15s. Independiente del HUD de
// Configuración — esta capa solo pinta zonas, sin caja de texto.

const POLL_MS = 15_000;

interface Zone {
  high: number | null;
  low: number | null;
  type: "supply" | "demand";
}

function telemetryRoot(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/_X\d+M?$/i, "")
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

export function CamaronZonesLayer({ symbol }: { symbol: string | null }) {
  const [on, setOn] = useState<boolean>(() => isCamaronZonesOn());
  const [zones, setZones] = useState<Zone[]>([]);
  const idsRef = useRef<string[]>([]);

  useEffect(() => onCamaronZonesChange(() => setOn(isCamaronZonesOn())), []);

  // Poll de zonas del motor
  useEffect(() => {
    if (!on || !symbol) {
      setZones([]);
      return;
    }
    let alive = true;
    const root = telemetryRoot(symbol);
    const tick = async () => {
      try {
        const res = await nestAuthFetch<{
          available: boolean;
          snapshot?: { results: Array<{ zones?: Zone[] }> };
        }>(`/api/admin/strategy-telemetry?symbol=${encodeURIComponent(root)}`);
        if (!alive) return;
        const zs = res?.available ? (res.snapshot?.results.find((r) => Array.isArray(r.zones))?.zones ?? []) : [];
        setZones(zs);
      } catch {
        if (alive) setZones([]);
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
    const tStart = data[Math.max(0, data.length - 90)].timestamp;
    zones.forEach((z, idx) => {
      if (z.high == null || z.low == null) return;
      const supply = z.type === "supply";
      const id = `kai-camzone-${idx}`;
      try {
        chart.createOverlay({
          name: "rect",
          id,
          groupId: "kai_camaron_zones",
          lock: true,
          points: [
            { timestamp: tStart, value: z.high },
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

  return null;
}
