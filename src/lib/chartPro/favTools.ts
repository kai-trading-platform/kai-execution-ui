import { useCallback, useSyncExternalStore } from "react";

// Herramientas de dibujo favoritas (estilo TradingView: ⭐ en el menú lateral →
// aparecen en una barra flotante de acceso rápido sobre el chart).
//
// IMPORTANTE (puente cross-framework): la ⭐ se togglea desde el fork del chart
// (Solid) Y desde React. localStorage es la fuente de verdad compartida, y un
// evento de window (`kai:favtools`) notifica cambios en la MISMA pestaña (el
// evento `storage` solo dispara ENTRE pestañas). El fork despacha ese mismo
// evento al escribir; acá lo escuchamos.
const KEY = "kai.chart.favTools";
export const FAVTOOLS_EVENT = "kai:favtools";

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((t) => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export function toggleFavTool(name: string): void {
  const cur = read();
  const next = cur.includes(name) ? cur.filter((t) => t !== name) : [...cur, name];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* noop */
  }
  window.dispatchEvent(new Event(FAVTOOLS_EVENT));
}

function subscribe(cb: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) cb();
  };
  window.addEventListener(FAVTOOLS_EVENT, cb);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(FAVTOOLS_EVENT, cb);
    window.removeEventListener("storage", onStorage);
  };
}

// Referencia estable mientras no cambie (cache por raw string).
let cacheRaw: string | null = null;
let cacheVal: string[] = read();
const EMPTY: string[] = [];
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

export function useFavTools(): { favs: string[]; toggle: (name: string) => void; isFav: (name: string) => boolean } {
  const favs = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  const toggle = useCallback((name: string) => toggleFavTool(name), []);
  const isFav = useCallback((name: string) => favs.includes(name), [favs]);
  return { favs, toggle, isFav };
}
