// Scripts de SISTEMA del panel Pine: fijos (no editables ni borrables), anclados
// arriba de "Mis scripts". El de Camarón no compila Pine — al añadirlo al chart
// activa la capa de ZONAS EN VIVO del motor (telemetría real) para ver por qué
// hace las entradas.

export interface SystemScript {
  id: string;
  name: string;
  source: string;
}

const CAMARON_SOURCE = `// ═══════════ CAMARÓN · script de sistema (solo lectura) ═══════════
//
// Al darle "Añadir al chart" se pintan las ZONAS REALES que el motor
// Camarón está usando AHORA MISMO (telemetría en vivo, se refresca sola):
//   ▉ verde  = zona de DEMANDA (compras institucionales)
//   ▉ rojo   = zona de OFERTA  (ventas institucionales)
//
// ── POR QUÉ ENTRA EL CAMARÓN ──────────────────────────────────────
// 1. Marca zonas limpias de oferta/demanda en M15 y las refina en M5
//    (sin timeframes mayores).
// 2. Espera un SWEEP de liquidez: el precio barre la zona (caza los
//    stops que descansan ahí) y RECHAZA de vuelta.
// 3. Entra en el rechazo — con sniper M1/M3 si está activo — con SL
//    CORTO detrás de la zona barrida (ahí vive el edge).
// 4. TP estructural: la siguiente zona limpia / high-low previo.
//    Nada de TP por ATR. El BE-lock protege la posición al 0.55R.
// 5. Gates antes de cada entrada: sesión (NY/Londres/Asia), noticias,
//    drawdown diario, rachas y confluencia de activos líderes.
//
// La razón EXACTA de cada decisión (o de por qué NO está entrando en
// este momento) la ves en: Configuración ⚙ → Telemetría de estrategias.
//
// Este script es fijo del sistema: no se puede editar ni borrar.
`;

export const SYSTEM_SCRIPTS: SystemScript[] = [
  {
    id: "system-camaron",
    name: "CAMARÓN · zonas en vivo",
    source: CAMARON_SOURCE,
  },
];

// ── Estado "aplicado al chart" (persistido; lo lee CamaronZonesLayer) ────────

const APPLIED_KEY = "kai:pine:camaronZones";
const listeners = new Set<() => void>();

export function isCamaronZonesOn(): boolean {
  try {
    return localStorage.getItem(APPLIED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCamaronZonesOn(on: boolean): void {
  try {
    localStorage.setItem(APPLIED_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
}

export function onCamaronZonesChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ── Disponibilidad de zonas para el símbolo actual (la reporta la capa) ─────
// El aviso "el motor no evalúa X" vive en el PANEL Pine, no sobre el chart
// (feedback usuario): la capa publica aquí y el panel lo muestra.

let zonesStatus: { root: string; available: boolean } | null = null;

export function setCamaronZonesStatus(root: string, available: boolean): void {
  zonesStatus = { root, available };
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
}

export function getCamaronZonesStatus(): { root: string; available: boolean } | null {
  return zonesStatus;
}
