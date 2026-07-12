// Marcadores de trades CERRADOS sobre el chart (klinecharts). Dibuja, por cada
// trade histórico del símbolo mostrado, una flecha LONG (arriba) / SHORT (abajo)
// anclada al precio+hora de ENTRADA, coloreada por resultado (verde ganancia /
// rojo pérdida) y con una etiqueta del PnL (p.ej. "+$788" / "-$81"). Si el trade
// trae precio+hora de SALIDA, además une entrada→salida con una línea punteada.
//
// El overlay es READ-ONLY (lock:true) y vive en su propio grupo, separado de los
// dibujos del usuario ('drawing_tools') y de las posiciones abiertas ('positions'),
// para que limpiarlo/redibujarlo no toque nada más.

import { registerOverlay, LineType } from 'klinecharts';
import type { OverlayCreate, OverlayTemplate } from 'klinecharts';

import type { TradingHistoryItem } from '@/types/trading';
import { formatSymbolDisplay } from '@/lib/symbolDisplay';

export const TRADE_MARKERS_GROUP = 'trade_history';
export const TRADE_MARKER_NAME = 'kaiTradeMarker';

const COLOR_WIN = '#2ed68d';
const COLOR_LOSS = '#ef5350';
const COLOR_NEUTRAL = 'rgba(226,228,233,0.7)';
const FONT = 'JetBrains Mono, ui-monospace, monospace';

// Códigos de mes de futuros (F,G,H,J,K,M,N,Q,U,V,X,Z) seguidos de 1-2 dígitos de
// año — p.ej. MNQU6, ESZ25, MGCH24. Se recortan para comparar por RAÍZ.
const FUTURES_MONTH_RE = /[FGHJKMNQUVXZ]\d{1,2}$/;

interface TradeMarkerData {
  side: 'buy' | 'sell';
  color: string;
  label: string;
}

/**
 * Normaliza un símbolo a una clave comparable: reusa `formatSymbolDisplay` (que
 * quita el sufijo del broker y arma pares FX/crypto) y además recorta el código
 * de contrato de futuros para que `MNQ` case con `MNQU6`.
 */
function normalizeSymbolKey(raw: string): string {
  const display = formatSymbolDisplay(raw)
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();
  return display.replace(FUTURES_MONTH_RE, '');
}

/** ¿El símbolo del trade corresponde al símbolo mostrado en el chart? */
export function symbolsMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a.toUpperCase() === b.toUpperCase()) return true;
  return normalizeSymbolKey(a) === normalizeSymbolKey(b);
}

function formatPnlLabel(pnl: number | null, side: 'buy' | 'sell'): string {
  if (pnl == null || !Number.isFinite(pnl)) {
    return side === 'buy' ? 'LONG' : 'SHORT';
  }
  const sign = pnl >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(Math.round(pnl)).toLocaleString('en-US')}`;
}

// --- Registro global del template (idempotente) -----------------------------
let registered = false;

/**
 * Registra el overlay `kaiTradeMarker` (una sola vez por sesión). Un marcador =
 * 1 punto (entrada). `totalStep: 2` → se considera "terminado" al crearlo con su
 * punto ya provisto. `needDefaultPointFigure:false` → sin manija arrastrable.
 */
export function registerTradeMarkerOverlay(): void {
  if (registered) return;
  registered = true;
  const template: OverlayTemplate = {
    name: TRADE_MARKER_NAME,
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 1) return [];
      const { x, y } = coordinates[0];
      const ext = (overlay.extendData ?? {}) as Partial<TradeMarkerData>;
      const color = ext.color ?? COLOR_NEUTRAL;
      const isBuy = ext.side !== 'sell';
      const half = 6; // media base del triángulo (px)
      const height = 12; // alto del triángulo (px)

      // Ápice EN el precio de entrada; base hacia el lado que no tapa la vela.
      // buy → flecha hacia ARRIBA (base debajo); sell → hacia ABAJO (base encima).
      const triangle = isBuy
        ? [{ x, y }, { x: x - half, y: y + height }, { x: x + half, y: y + height }]
        : [{ x, y }, { x: x - half, y: y - height }, { x: x + half, y: y - height }];
      const labelY = isBuy ? y + height + 2 : y - height - 2;
      const baseline = isBuy ? 'top' : 'bottom';

      const figures: Array<{ type: string; ignoreEvent?: boolean; attrs: unknown; styles?: unknown }> = [
        {
          type: 'polygon',
          ignoreEvent: true,
          attrs: { coordinates: triangle },
          styles: { style: 'fill', color },
        },
      ];
      if (ext.label) {
        figures.push({
          type: 'text',
          ignoreEvent: true,
          attrs: { x, y: labelY, text: ext.label, align: 'center', baseline },
          styles: { color, size: 11, family: FONT, weight: 'bold' },
        });
      }
      return figures;
    },
  };
  registerOverlay(template);
}

/**
 * Construye los `OverlayCreate` para todos los trades cerrados que coinciden con
 * `chartSymbol`. Cada trade aporta un marcador de entrada; si trae salida, además
 * una línea punteada entrada→salida. Filtra los que no tienen hora/precio válidos.
 */
export function buildTradeHistoryOverlays(
  trades: TradingHistoryItem[] | null | undefined,
  chartSymbol: string | null | undefined,
): OverlayCreate[] {
  if (!trades || !chartSymbol) return [];
  const out: OverlayCreate[] = [];
  for (const t of trades) {
    if (!t.symbol || !symbolsMatch(t.symbol, chartSymbol)) continue;
    const entryTs = t.openedAt ? Date.parse(t.openedAt) : NaN;
    if (!Number.isFinite(entryTs) || !Number.isFinite(t.entryPrice)) continue;

    const pnl = t.profitLoss;
    const color = pnl == null ? COLOR_NEUTRAL : pnl < 0 ? COLOR_LOSS : COLOR_WIN;

    out.push({
      name: TRADE_MARKER_NAME,
      groupId: TRADE_MARKERS_GROUP,
      lock: true,
      points: [{ timestamp: entryTs, value: t.entryPrice }],
      extendData: { side: t.side, color, label: formatPnlLabel(pnl, t.side) } satisfies TradeMarkerData,
    });

    // Conector entrada→salida cuando el broker ya reporta la salida. Hoy
    // `exitPrice` viene null (solo se ve la entrada), pero queda listo.
    if (t.exitPrice != null && Number.isFinite(t.exitPrice) && t.closedAt) {
      const exitTs = Date.parse(t.closedAt);
      if (Number.isFinite(exitTs)) {
        out.push({
          name: 'segment',
          groupId: TRADE_MARKERS_GROUP,
          lock: true,
          points: [
            { timestamp: entryTs, value: t.entryPrice },
            { timestamp: exitTs, value: t.exitPrice },
          ],
          styles: { line: { color, style: LineType.Dashed, size: 1 } },
        });
      }
    }
  }
  return out;
}
