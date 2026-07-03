import { useCallback, useRef } from "react";
import type { Overlay, OverlayMode, Point, DeepPartial, OverlayStyle } from "klinecharts";

// Persistencia de los dibujos (overlays de la DrawingBar) del chart Pro, por
// símbolo, en localStorage. Espeja el patrón de useTerminalSettings: try/catch en
// todo acceso a storage y escrituras "debounced" para no golpear localStorage en
// cada micro-movimiento del ratón mientras se arrastra un overlay.
//
// Sólo se guardan overlays del grupo 'drawing_tools' (las posiciones viven en el
// grupo 'positions' y NO se persisten). La clave es `kai:drawings:<symbol>`.

export interface SavedDrawing {
  id: string;
  name: string;
  points: Array<Partial<Point>>;
  extendData?: string;
  styles?: DeepPartial<OverlayStyle>;
  lock?: boolean;
  visible?: boolean;
  mode?: OverlayMode;
}

const KEY_PREFIX = "kai:drawings:";
const DEBOUNCE_MS = 300;

function storageKey(symbol: string): string {
  return `${KEY_PREFIX}${symbol}`;
}

function loadFromStorage(symbol: string): SavedDrawing[] {
  try {
    const raw = localStorage.getItem(storageKey(symbol));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedDrawing[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Overlay (klinecharts) → SavedDrawing (subset serializable + suficiente para
// recrearlo con createOverlay).
function serialize(o: Overlay): SavedDrawing {
  return {
    id: o.id,
    name: o.name,
    points: o.points,
    extendData: typeof o.extendData === "string" ? o.extendData : undefined,
    styles: o.styles ?? undefined,
    lock: o.lock,
    visible: o.visible,
    mode: o.mode,
  };
}

export function useChartDrawings() {
  // Cache en memoria: symbol → (id → SavedDrawing). Se hidrata perezosamente
  // desde localStorage la primera vez que se toca un símbolo.
  const cacheRef = useRef<Map<string, Map<string, SavedDrawing>>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const ensureLoaded = useCallback((symbol: string): Map<string, SavedDrawing> => {
    let map = cacheRef.current.get(symbol);
    if (!map) {
      map = new Map(loadFromStorage(symbol).map((d) => [d.id, d]));
      cacheRef.current.set(symbol, map);
    }
    return map;
  }, []);

  const flush = useCallback((symbol: string) => {
    const map = cacheRef.current.get(symbol);
    try {
      if (!map || map.size === 0) {
        localStorage.removeItem(storageKey(symbol));
      } else {
        localStorage.setItem(storageKey(symbol), JSON.stringify(Array.from(map.values())));
      }
    } catch {
      /* ignore */
    }
  }, []);

  const scheduleFlush = useCallback(
    (symbol: string) => {
      const existing = timersRef.current.get(symbol);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => {
        timersRef.current.delete(symbol);
        flush(symbol);
      }, DEBOUNCE_MS);
      timersRef.current.set(symbol, t);
    },
    [flush],
  );

  const getDrawings = useCallback(
    (symbol: string): SavedDrawing[] => {
      if (!symbol) return [];
      return Array.from(ensureLoaded(symbol).values());
    },
    [ensureLoaded],
  );

  const saveDrawing = useCallback(
    (symbol: string, overlay: Overlay) => {
      if (!symbol) return;
      const map = ensureLoaded(symbol);
      map.set(overlay.id, serialize(overlay));
      scheduleFlush(symbol);
    },
    [ensureLoaded, scheduleFlush],
  );

  const removeDrawing = useCallback(
    (symbol: string, id: string) => {
      if (!symbol) return;
      const map = ensureLoaded(symbol);
      if (map.delete(id)) scheduleFlush(symbol);
    },
    [ensureLoaded, scheduleFlush],
  );

  return { getDrawings, saveDrawing, removeDrawing };
}
