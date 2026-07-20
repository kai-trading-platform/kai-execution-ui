// Registro global de la instancia klinecharts ACTIVA del chart Pro (patrón
// setKaiPositionCloseHandler): KaiChartPro la publica al crear el widget y la
// limpia al desmontar. Consumidores (editor Kai Pine) la leen para crear/quitar
// indicadores sin acoplarse al árbol de React.

import type { Chart } from "klinecharts";

let activeChart: Chart | null = null;
const readyListeners = new Set<(chart: Chart) => void>();

export function setActiveProChart(chart: Chart | null): void {
  activeChart = chart;
  if (chart) {
    for (const cb of readyListeners) {
      try {
        cb(chart);
      } catch {
        /* listener roto no tumba el chart */
      }
    }
  }
}

export function getActiveProChart(): Chart | null {
  return activeChart;
}

/** Suscribe un callback para cuando el chart (re)aparezca. Devuelve unsubscribe. */
export function onProChartReady(cb: (chart: Chart) => void): () => void {
  readyListeners.add(cb);
  if (activeChart) {
    try {
      cb(activeChart);
    } catch {
      /* ignore */
    }
  }
  return () => readyListeners.delete(cb);
}
