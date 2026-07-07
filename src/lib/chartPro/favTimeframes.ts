import { useCallback, useSyncExternalStore } from "react";
import { CHART_PRO_PERIODS } from "./periods";

// Favoritos de temporalidad persistidos en localStorage (estilo TradingView:
// el usuario ancla sus TFs más usados a una botonera de acceso rápido).
const KEY = "kai.chart.favTimeframes";
const DEFAULTS = ["5m", "15m", "1h", "4h", "D"];

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return DEFAULTS;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string") : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

const listeners = new Set<() => void>();
function emit() {
  listeners.forEach((l) => l());
}

export function toggleFavTimeframe(tf: string): void {
  const cur = read();
  const next = cur.includes(tf) ? cur.filter((t) => t !== tf) : [...cur, tf];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* localStorage lleno / bloqueado: no rompemos la UI */
  }
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", onStorage);
  };
}

// getSnapshot debe devolver una referencia ESTABLE mientras no cambie el valor
// (si no, useSyncExternalStore entra en loop). Cacheamos por el raw string.
let cacheRaw: string | null = null;
let cacheVal: string[] = read();
function getSnapshot(): string[] {
  const raw = (() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  })();
  if (raw !== cacheRaw) {
    cacheRaw = raw;
    cacheVal = read();
  }
  return cacheVal;
}

export interface FavTimeframes {
  /** Favoritos ordenados por el orden canónico de períodos. */
  favs: string[];
  toggle: (tf: string) => void;
  isFav: (tf: string) => boolean;
}

export function useFavTimeframes(): FavTimeframes {
  const raw = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULTS);
  const favs = CHART_PRO_PERIODS.map((p) => p.text).filter((t) => raw.includes(t));
  const toggle = useCallback((tf: string) => toggleFavTimeframe(tf), []);
  const isFav = useCallback((tf: string) => raw.includes(tf), [raw]);
  return { favs, toggle, isFav };
}
