// Persistencia localStorage de los scripts Kai Pine (patrón useChartDrawings /
// useTerminalSettings: try/catch en todo acceso). Los scripts viven en ESTE
// navegador; fase 2 opcional: moverlos al servidor.

export interface PineScript {
  id: string;
  name: string;
  source: string;
  updatedAt: number;
}

export interface AppliedPine {
  scriptId: string;
  /** Pane donde vive el indicador ('candle_pane' para overlay). */
  paneId: string;
}

const SCRIPTS_KEY = "kai:pine:scripts";
const APPLIED_KEY = "kai:pine:applied";

export function loadScripts(): PineScript[] {
  try {
    const raw = localStorage.getItem(SCRIPTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PineScript[];
    return Array.isArray(parsed) ? parsed.filter((s) => s && s.id && typeof s.source === "string") : [];
  } catch {
    return [];
  }
}

export function saveScripts(scripts: PineScript[]): void {
  try {
    localStorage.setItem(SCRIPTS_KEY, JSON.stringify(scripts));
  } catch {
    /* ignore */
  }
}

export function loadApplied(): AppliedPine[] {
  try {
    const raw = localStorage.getItem(APPLIED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AppliedPine[];
    return Array.isArray(parsed) ? parsed.filter((a) => a && a.scriptId) : [];
  } catch {
    return [];
  }
}

export function saveApplied(applied: AppliedPine[]): void {
  try {
    localStorage.setItem(APPLIED_KEY, JSON.stringify(applied));
  } catch {
    /* ignore */
  }
}

export function newScriptId(): string {
  return `pine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
