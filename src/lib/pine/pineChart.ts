// Puente Kai Pine ↔ klinecharts: registra el script compilado como indicador
// (nombre estable KAI_PINE_<id>) y lo crea/quita del chart. El estado "qué
// scripts están aplicados" vive en localStorage (pineStore) para sobrevivir
// refrescos: KaiChartPro llama reapplyStoredPineScripts() al montar el chart.

import { LineType, registerIndicator, type Chart, type IndicatorFigureStyle, type KLineData } from "klinecharts";

import { compilePine, type CompiledPine, type PineCompileError } from "./compilePine";
import { loadApplied, loadScripts, saveApplied, type PineScript } from "./pineStore";

const CANDLE_PANE_ID = "candle_pane";

function indicatorName(scriptId: string): string {
  return `KAI_PINE_${scriptId}`;
}

/** registerIndicator es global e idempotente por nombre: re-registrar actualiza. */
function registerCompiled(scriptId: string, compiled: CompiledPine): void {
  registerIndicator({
    name: indicatorName(scriptId),
    shortName: compiled.title,
    figures: compiled.figures.map((f) => ({
      key: f.key,
      title: `${f.title}: `,
      type: "line",
      // El intersection type de IndicatorFigureStyle colapsa `style` a
      // PolygonType; para líneas klinecharts espera LineType en runtime —
      // doble cast vía unknown (el propio type es `& Record<string, any>`).
      styles: () =>
        ({
          color: f.color,
          size: f.linewidth,
          style: f.isLevel ? LineType.Dashed : LineType.Solid,
        }) as unknown as IndicatorFigureStyle,
    })),
    calc: (dataList: KLineData[]) =>
      compiled.calc(
        dataList.map((d) => ({
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
          volume: d.volume ?? 0,
          time: d.timestamp,
        })),
      ),
  });
}

export type ApplyResult = { ok: true } | { ok: false; error: PineCompileError };

/** Compila y aplica (o actualiza) un script en el chart. Persiste en applied. */
export function applyPineScript(chart: Chart, script: PineScript): ApplyResult {
  const res = compilePine(script.source);
  if (!res.ok) return { ok: false, error: res.error };

  const name = indicatorName(script.id);
  const applied = loadApplied();
  const existing = applied.find((a) => a.scriptId === script.id);

  // Si ya estaba aplicado, quitarlo primero (el overlay pudo cambiar de pane).
  if (existing) {
    try {
      chart.removeIndicator(existing.paneId, name);
    } catch {
      /* pane ya no existe */
    }
  }

  registerCompiled(script.id, res.compiled);
  const paneId = res.compiled.overlay
    ? chart.createIndicator(name, true, { id: CANDLE_PANE_ID })
    : chart.createIndicator(name, false);
  if (!paneId) {
    return { ok: false, error: { message: "klinecharts no pudo crear el indicador", line: 1 } };
  }

  const next = applied.filter((a) => a.scriptId !== script.id);
  next.push({ scriptId: script.id, paneId });
  saveApplied(next);
  return { ok: true };
}

/** Quita el indicador del chart y lo saca del applied persistido. */
export function removePineScript(chart: Chart, scriptId: string): void {
  const applied = loadApplied();
  const entry = applied.find((a) => a.scriptId === scriptId);
  if (entry) {
    try {
      chart.removeIndicator(entry.paneId, indicatorName(scriptId));
    } catch {
      /* pane ya no existe */
    }
  }
  saveApplied(applied.filter((a) => a.scriptId !== scriptId));
}

export function isPineApplied(scriptId: string): boolean {
  return loadApplied().some((a) => a.scriptId === scriptId);
}

/**
 * Re-aplica al chart recién creado los scripts marcados como aplicados
 * (refresco de página / recreación del widget). Scripts borrados o que ya no
 * compilan se sacan del applied en silencio.
 */
export function reapplyStoredPineScripts(chart: Chart): void {
  const scripts = new Map(loadScripts().map((s) => [s.id, s]));
  const applied = loadApplied();
  const surviving: typeof applied = [];
  for (const entry of applied) {
    const script = scripts.get(entry.scriptId);
    if (!script) continue;
    const res = compilePine(script.source);
    if (!res.ok) continue;
    registerCompiled(script.id, res.compiled);
    const paneId = res.compiled.overlay
      ? chart.createIndicator(indicatorName(script.id), true, { id: CANDLE_PANE_ID })
      : chart.createIndicator(indicatorName(script.id), false);
    if (paneId) surviving.push({ scriptId: script.id, paneId });
  }
  saveApplied(surviving);
}
