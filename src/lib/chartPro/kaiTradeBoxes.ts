// Cajas LONG/SHORT (herramienta `positionLong`/`positionShort` del fork) para
// dibujar CADA trade de Kai sobre el chart: posiciones abiertas y trades cerrados
// del símbolo mostrado, con Entry/SL/TP REALES. Reemplaza las viejas líneas
// punteadas (abiertas) y flechitas de PnL (cerradas).
//
// La plantilla del fork deriva el Stop del 2º punto y el Target del múltiplo R,
// así que sembramos `point[1]` en el SL real y pasamos el R real por
// `extendData.rr` → el Target cae exactamente en el TP real. `rr === null` (sin
// TP) → la plantilla no dibuja zona de target. Sin SL → caja "degenerada":
// point[1] = entry, sólo se ve la línea de entrada.
//
// Las cajas viven en su propio grupo (no se persisten como dibujos del usuario) y
// se crean con `id` estable por trade para reconciliar sin borrar ediciones.

import type { OverlayCreate } from 'klinecharts';

import type { CopyTradingPosition } from '@/modules/copyTrading/types';
import type { TradingHistoryItem } from '@/types/trading';
import { symbolsMatch } from './tradeMarkers';
import { KAI_POSITION_BOX_NAME } from './kaiPositionBox';

export const KAI_TRADES_GROUP = 'kai_trades';

/**
 * Fallback del borde izquierdo (t0) de una posición ABIERTA cuando no trae hora
 * de apertura. Las posiciones Rithmic (futuros reales) NUNCA la traen — el
 * snapshot del bridge no incluye timestamp de apertura → openedAt null. Sin un
 * t0 válido la caja se saltaba y "no salía el dibujo de short/long". 2h es una
 * ventana cómoda para el intradía de futuros; el borde derecho es siempre `now`.
 */
const OPEN_BOX_FALLBACK_MS = 2 * 60 * 60 * 1000;

export interface KaiTradeBox {
  id: string;
  overlay: OverlayCreate;
}

interface BuildArgs {
  positions?: CopyTradingPosition[] | null;
  history?: TradingHistoryItem[] | null;
  symbol?: string | null;
  /** Ajuste del terminal: si es false no se dibuja ninguna caja. */
  showPositions?: boolean;
  /** Ajuste del terminal: si es false la caja muestra sólo la entrada (sin SL/TP). */
  showTpSl?: boolean;
  /** Timestamp (ms) para el borde derecho de las posiciones abiertas (=ahora). */
  now: number;
  /** Spec del símbolo activo (futuros) para calcular el USD en SL/TP. */
  tickSize?: number | null;
  tickValue?: number | null;
}

// USD por 1.0 de precio y por contrato = tickValue / tickSize. null si falta spec.
function usdPerPoint(tickSize?: number | null, tickValue?: number | null): number | null {
  if (tickSize == null || tickValue == null) return null;
  if (!(tickSize > 0) || !(tickValue > 0)) return null;
  return tickValue / tickSize;
}

// Múltiplo R real del trade: |target-entry| / |entry-stop|. null si falta el
// target o el riesgo es cero (evita dividir por cero).
function realRR(entry: number, stop: number, target: number | null): number | null {
  if (target == null || !Number.isFinite(target)) return null;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return Math.abs(target - entry) / risk;
}

function boxFor(params: {
  id: string;
  side: 'long' | 'short';
  entry: number;
  stop: number | null;
  target: number | null;
  t0: number;
  t1: number;
  showTpSl: boolean;
  /** Sólo el trade ABIERTO rotula TP/Entry/SL; los cerrados dejan la caja pelada. */
  showLabels: boolean;
  /** Detalle de orden para las split-labels estilo TV (sólo trade abierto). */
  order?: {
    rawSide: 'buy' | 'sell';
    qty: number;
    pnlUsd: number;
    ticket: string;
    tickSize?: number | null;
    tickValue?: number | null;
  };
}): KaiTradeBox | null {
  const { id, side, entry, t0, t1, showTpSl, showLabels, order } = params;
  if (!Number.isFinite(entry) || !Number.isFinite(t0) || !Number.isFinite(t1)) return null;

  // showTpSl off → caja sólo-entrada. Sin SL → degenerada (point[1] = entry).
  const stop = showTpSl ? params.stop : null;
  const target = showTpSl ? params.target : null;
  const anchor = stop != null && Number.isFinite(stop) ? stop : entry;
  const rr = stop != null && Number.isFinite(stop) ? realRR(entry, stop, target) : null;

  // USD potencial en SL/TP: distancia (en precio) × USD-por-punto × contratos.
  // SL siempre es pérdida (negativo), TP siempre ganancia (positivo).
  let usdAtStop: number | undefined;
  let usdAtTarget: number | undefined;
  if (order && showLabels) {
    const usdPP = usdPerPoint(order.tickSize, order.tickValue);
    if (usdPP != null && order.qty > 0) {
      if (stop != null && Number.isFinite(stop)) usdAtStop = -Math.abs(entry - stop) * usdPP * order.qty;
      if (target != null && Number.isFinite(target)) usdAtTarget = Math.abs(target - entry) * usdPP * order.qty;
    }
  }

  const orderExt =
    order && showLabels
      ? {
          side: order.rawSide,
          qty: order.qty,
          pnlUsd: order.pnlUsd,
          ticket: order.ticket,
          ...(usdAtStop != null ? { usdAtStop } : {}),
          ...(usdAtTarget != null ? { usdAtTarget } : {}),
        }
      : {};

  return {
    id,
    overlay: {
      name: KAI_POSITION_BOX_NAME,
      groupId: KAI_TRADES_GROUP,
      lock: true,
      points: [
        { timestamp: t0, value: entry },
        { timestamp: t1, value: anchor },
      ],
      extendData: { isLong: side === 'long', rr, showLabels, ...orderExt },
    },
  };
}

export function buildKaiTradeBoxes(args: BuildArgs): KaiTradeBox[] {
  const { symbol, showPositions = true, showTpSl = true, now } = args;
  if (!symbol || !showPositions) return [];

  const out: KaiTradeBox[] = [];

  for (const p of args.positions ?? []) {
    if (!symbolsMatch(p.symbol, symbol)) continue;
    // Rithmic (futuros reales) no reporta hora de apertura → openedAtIso null.
    // Antes se saltaba la caja ("no salía el dibujo de short"); ahora caemos a
    // una ventana fija hacia atrás para que SIEMPRE se dibuje (borde derecho = now).
    const parsedT0 = p.openedAtIso ? Date.parse(p.openedAtIso) : NaN;
    const t0 = Number.isFinite(parsedT0) ? parsedT0 : now - OPEN_BOX_FALLBACK_MS;
    const box = boxFor({
      id: `kaipos-${p.id}`,
      side: p.side === 'LONG' ? 'long' : 'short',
      entry: p.avgPrice,
      stop: p.sl,
      target: p.tp,
      t0,
      t1: now,
      showTpSl,
      showLabels: true, // posición ABIERTA → rotula TP/Entry/SL
      order: {
        rawSide: p.side === 'LONG' ? 'buy' : 'sell',
        qty: p.qty,
        pnlUsd: p.openPnlUsd,
        ticket: String(p.id),
        tickSize: args.tickSize,
        tickValue: args.tickValue,
      },
    });
    if (box) out.push(box);
  }

  // Trades CERRADOS: se dibujan como un trade NORMAL (caja Entry/SL/TP), igual
  // que las abiertas — sin etiqueta LONG/SHORT ni PnL.
  for (const t of args.history ?? []) {
    if (!t.symbol || !symbolsMatch(t.symbol, symbol)) continue;
    const t0 = t.openedAt ? Date.parse(t.openedAt) : NaN;
    if (!Number.isFinite(t0)) continue;
    const t1raw = t.closedAt ? Date.parse(t.closedAt) : now;
    const box = boxFor({
      id: `kaihist-${t.id}`,
      side: t.side === 'buy' ? 'long' : 'short',
      entry: t.entryPrice,
      stop: t.stopLoss,
      target: t.takeProfit,
      t0,
      t1: Number.isFinite(t1raw) ? t1raw : now,
      showTpSl,
      showLabels: false, // trade CERRADO → caja sin etiquetas
    });
    if (box) out.push(box);
  }

  return out;
}
