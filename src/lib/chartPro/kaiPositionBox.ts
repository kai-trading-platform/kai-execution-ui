// Caja de posición READ-ONLY para los trades de Kai (abiertos y cerrados), con el
// look de la "vista de órdenes activas" de un broker en TradingView: zona verde
// (Entry→Target) y roja (Entry→Stop) translúcidas, LÍNEAS PUNTEADAS de nivel que
// cruzan hasta el eje de precios, y —flotando a la izquierda del eje— una tira de
// SPLIT-LABELS por nivel: [ info lado/qty ] · [ USD ] · [ × ].
//
// Es un overlay PROPIO (no la herramienta manual positionLong/Short). Se desactivan
// todas las figuras default y controlamos el dibujo 100%.
//
// Puntos: [ {t0, entry}, {t1, stop} ]. Dirección/target salen de extendData
// { isLong, rr }. El detalle de orden (lado, contratos, USD en SL/TP, P&L, ticket)
// también viaja por extendData — SÓLO el trade abierto lo muestra.
//
// La '×' de los tres niveles es clickable: su figura lleva key `kaiclose:<ticket>`
// con ignoreEvent:false; el onClick del template llama al handler registrado por la
// app (setKaiPositionCloseHandler) para cerrar la posición sin ensuciar estado global.

import { registerOverlay } from 'klinecharts';
import type { OverlayFigure, OverlayTemplate } from 'klinecharts';

export const KAI_POSITION_BOX_NAME = 'kaiPositionBox';

// ── Paleta oficial TradingView ────────────────────────────────────────────────
const COLOR_TARGET = '#089981';
const COLOR_STOP = '#f23645';
const COLOR_ENTRY_LINE = '#787b86';
const FILL_TARGET = 'rgba(8,153,129,0.2)';
const FILL_STOP = 'rgba(242,54,69,0.2)';
const INFO_BG = '#2a2e39'; // caja izquierda (lado/qty) sólida, sin borde
const ENTRY_BG = '#2a2e39'; // "tier gris" del nivel de entrada (valor + ×)
const INFO_TEXT = '#ffffff';
const WHITE = '#ffffff';
const DIVIDER = 'rgba(0,0,0,0.28)'; // groove sutil entre valor y botón ×
const FONT = 'JetBrains Mono, ui-monospace, monospace';

// ── Geometría de las split-labels ─────────────────────────────────────────────
const FONT_SIZE = 11;
const AXIS_TAG_SIZE = 12; // tag del eje Y ≈ tamaño de la escala nativa
// Fuente sans (como la escala de precios nativa de klinecharts), más angosta que
// la monospace de las etiquetas → el precio entra sin clipear en el eje.
const AXIS_TAG_FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const CHAR_W = 6.6; // ancho aprox por carácter monospace @ 11px (para maquetar contiguo)
const ROW_H = 20; // alto total de la fila (TV ~20-24px)
const PADX = 6; // padding horizontal interno de cada caja
const RADIUS = 2; // esquinas sutiles (no píldora)
const AXIS_GAP = 2; // la fila flota justo a la izquierda del eje
const MIN_WIDTH_PX = 96;

const boxW = (t: string) => Math.ceil(t.length * CHAR_W) + PADX * 2;
const fmtUsd = (v: number) => `${v >= 0 ? '+' : '-'} ${Math.abs(v).toFixed(2)} USD`;

interface KaiBoxData {
  isLong: boolean;
  rr: number | null; // |tp-entry|/|entry-sl|; null si no hay TP
  showLabels?: boolean;
  // Detalle de la orden (sólo trade ABIERTO). Si falta, cae al precio como fallback.
  side?: 'buy' | 'sell';
  qty?: number;
  pnlUsd?: number; // P&L abierto en vivo → fila de entrada
  usdAtStop?: number; // pérdida potencial si toca SL (negativo)
  usdAtTarget?: number; // ganancia potencial si toca TP (positivo)
  ticket?: string; // para cerrar vía la '×'
}

// ── Handler de cierre (lo registra la app; el overlay sólo lo invoca) ─────────
type CloseHandler = (ticket: string) => void;
let closeHandler: CloseHandler | null = null;
export function setKaiPositionCloseHandler(fn: CloseHandler | null): void {
  closeHandler = fn;
}

// Segmento de una fila de split-labels.
interface Seg {
  text: string;
  bg: string;
  fg: string;
  weight?: number | string;
  square?: boolean; // ancho = ROW_H (botón ×)
  closeKey?: string; // si se define → figura clickable con ese key
  leftDivider?: boolean; // groove vertical de 1px a la izquierda de la caja
}

// Dibuja una fila de cajas CONTIGUAS (0px gap, comparten borde), ancladas por su
// borde derecho a rightAnchorX, centrada verticalmente en centerY. Sólo la primera
// caja redondea sus esquinas izquierdas y la última sus esquinas derechas.
function rowFigures(centerY: number, segs: Seg[], rightAnchorX: number): OverlayFigure[] {
  const widths = segs.map((s) => (s.square ? ROW_H : boxW(s.text)));
  const total = widths.reduce((a, b) => a + b, 0);
  const top = centerY - ROW_H / 2;
  const last = segs.length - 1;
  const figs: OverlayFigure[] = [];
  let x = rightAnchorX - total;

  segs.forEach((s, i) => {
    const w = widths[i];
    // borderRadius es uniforme por caja: sólo redondea la 1ª y la última → los
    // extremos de la tira quedan redondeados y las uniones internas rectas.
    const radius = i === 0 || i === last ? RADIUS : 0;
    figs.push({
      type: 'rect',
      ignoreEvent: s.closeKey ? false : true,
      ...(s.closeKey ? { key: s.closeKey } : {}),
      attrs: { x, y: top, width: w, height: ROW_H },
      styles: { style: 'fill', color: s.bg, borderRadius: radius },
    });
    if (s.leftDivider) {
      figs.push({
        type: 'line',
        ignoreEvent: true,
        attrs: { coordinates: [{ x, y: top }, { x, y: top + ROW_H }] },
        styles: { color: DIVIDER, style: 'solid', size: 1 },
      });
    }
    figs.push({
      type: 'text',
      ignoreEvent: true,
      attrs: { x: x + w / 2, y: centerY, text: s.text, align: 'center', baseline: 'middle' },
      styles: {
        size: s.square ? 14 : FONT_SIZE,
        family: FONT,
        weight: s.weight ?? 'normal',
        color: s.fg,
        paddingLeft: 0,
        paddingRight: 0,
        paddingTop: 0,
        paddingBottom: 0,
        borderSize: 0,
        backgroundColor: 'rgba(0,0,0,0)',
      },
    });
    x += w;
  });

  return figs;
}

let registered = false;

export function registerKaiPositionBoxOverlay(): void {
  if (registered) return;
  registered = true;
  const template: OverlayTemplate = {
    name: KAI_POSITION_BOX_NAME,
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    onClick: (event) => {
      const key = event.figureKey ?? '';
      if (key.startsWith('kaiclose:')) {
        const ticket = key.slice('kaiclose:'.length);
        if (ticket && closeHandler) closeHandler(ticket);
        return true;
      }
      return false;
    },
    createPointFigures: ({ coordinates, overlay, precision, bounding }) => {
      if (coordinates.length < 2) return [];
      const ext = (overlay.extendData ?? {}) as Partial<KaiBoxData>;
      const isLong = ext.isLong !== false;
      const showLabels = ext.showLabels !== false;
      const rr = ext.rr;
      const showTarget = rr != null && Number.isFinite(rr) && (rr as number) > 0;
      const rrVal = showTarget ? (rr as number) : 0;

      const entryY = coordinates[0].y;
      const dPix = Math.abs(coordinates[1].y - entryY);
      const hasStop = dPix > 0.5;
      const stopY = isLong ? entryY + dPix : entryY - dPix;
      const targetY = isLong ? entryY - rrVal * dPix : entryY + rrVal * dPix;

      const leftX = Math.min(coordinates[0].x, coordinates[1].x);
      const rawRight = Math.max(coordinates[0].x, coordinates[1].x);
      // Caja/zonas: hasta el borde del recuadro RR (con ancho mínimo si es delgado).
      const boxRightX = showLabels
        ? rawRight - leftX < MIN_WIDTH_PX
          ? leftX + MIN_WIDTH_PX
          : rawRight
        : rawRight;
      // Líneas de nivel y anclaje de las etiquetas: hasta el eje (borde derecho del pane).
      const axisX = bounding.width - AXIS_GAP;

      // Fallback de precio (por si aún no llega el USD real).
      const entryVal = overlay.points[0].value as number;
      const dVal = Math.abs(entryVal - (overlay.points[1].value as number));
      const stopVal = isLong ? entryVal - dVal : entryVal + dVal;
      const targetVal = isLong ? entryVal + rrVal * dVal : entryVal - rrVal * dVal;
      const pr = (precision as unknown as { price: number }).price;

      const zone = (y: number) => ({
        coordinates: [
          { x: leftX, y: entryY }, { x: boxRightX, y: entryY },
          { x: boxRightX, y }, { x: leftX, y },
        ],
      });

      // Línea de nivel: cruza desde el recuadro hasta el eje. SL/TP punteadas,
      // entrada sólida (dónde estás vs a dónde vas — look TradingView).
      const levelLine = (
        y: number,
        color: string,
        dashed: boolean,
        rightX: number = axisX,
      ): OverlayFigure => ({
        type: 'line',
        ignoreEvent: true,
        attrs: { coordinates: [{ x: leftX, y }, { x: rightX, y }] },
        styles: dashed
          ? { color, style: 'dashed', size: 1, dashedValue: [4, 3] }
          : { color, style: 'solid', size: 1 },
      });

      const figs: OverlayFigure[] = [];

      // 1) Zonas (fill) — al fondo, sólo hasta el recuadro RR.
      if (showTarget) {
        figs.push({ type: 'polygon', ignoreEvent: true, attrs: zone(targetY), styles: { style: 'fill', color: FILL_TARGET } });
      }
      if (hasStop) {
        figs.push({ type: 'polygon', ignoreEvent: true, attrs: zone(stopY), styles: { style: 'fill', color: FILL_STOP } });
      }

      // 2) Líneas de nivel (Entry sólida, TP/SL punteadas). Trade ABIERTO: hasta
      // el eje de precios. Trade CERRADO (sin labels): sólo dentro de su propio
      // tramo (entrada→salida) para que la caja se VEA claramente sin ensuciar
      // todo el chart con líneas horizontales de trades pasados. Antes los trades
      // cerrados dibujaban sólo las zonas translúcidas y "no se veía" el dibujo.
      const lineRight = showLabels ? axisX : boxRightX;
      // Las líneas PUNTEADAS de TP/SL (bordes arriba/abajo de la caja) solo se
      // dibujan en posiciones ABIERTAS, donde conectan la caja con los tags del
      // eje. En trades CERRADOS / cajas de análisis (!showLabels) las zonas ya
      // delimitan la caja, así que las punteadas sobran (feedback usuario).
      if (showLabels && showTarget)
        figs.push(levelLine(targetY, COLOR_TARGET, true, lineRight));
      if (showLabels && hasStop)
        figs.push(levelLine(stopY, COLOR_STOP, true, lineRight));
      figs.push(levelLine(entryY, COLOR_ENTRY_LINE, false, lineRight));

      if (!showLabels) return figs;

      // 3) Split-labels [ info ] · [ USD ] · [ × ] flotando a la izquierda del eje.
      const side = ext.side === 'buy' ? 'Buy' : 'Sell';
      const qty = ext.qty;
      const infoText = qty != null ? `${qty} ${side}` : side;
      const ticket = ext.ticket;
      const closeSeg = (bg: string): Seg => ({
        text: '×', bg, fg: WHITE, square: true, leftDivider: true,
        ...(ticket ? { closeKey: `kaiclose:${ticket}` } : {}),
      });

      // TP (verde)
      if (showTarget) {
        const val = ext.usdAtTarget != null && Number.isFinite(ext.usdAtTarget)
          ? fmtUsd(ext.usdAtTarget)
          : targetVal.toFixed(pr);
        figs.push(...rowFigures(targetY, [
          { text: infoText, bg: INFO_BG, fg: INFO_TEXT },
          { text: val, bg: COLOR_TARGET, fg: WHITE, weight: 500 },
          closeSeg(COLOR_TARGET),
        ], axisX));
      }

      // Entrada (tier gris) — ahora también con ×.
      {
        const val = ext.pnlUsd != null && Number.isFinite(ext.pnlUsd)
          ? fmtUsd(ext.pnlUsd)
          : entryVal.toFixed(pr);
        figs.push(...rowFigures(entryY, [
          { text: infoText, bg: INFO_BG, fg: INFO_TEXT },
          { text: val, bg: ENTRY_BG, fg: WHITE, weight: 500, leftDivider: true },
          closeSeg(ENTRY_BG),
        ], axisX));
      }

      // SL (rojo)
      if (hasStop) {
        const val = ext.usdAtStop != null && Number.isFinite(ext.usdAtStop)
          ? fmtUsd(ext.usdAtStop)
          : stopVal.toFixed(pr);
        figs.push(...rowFigures(stopY, [
          { text: infoText, bg: INFO_BG, fg: INFO_TEXT },
          { text: val, bg: COLOR_STOP, fg: WHITE, weight: 500 },
          closeSeg(COLOR_STOP),
        ], axisX));
      }

      return figs;
    },
    // Tags de precio incrustados en el eje Y (escala derecha), estilo TradingView:
    // SL rojo / TP verde con el precio exacto, alineados a su nivel. Se dibujan
    // sobre la escala nativa (tapan el número del scale a esa altura, como TV).
    createYAxisFigures: ({ coordinates, overlay, precision, bounding, thousandsSeparator }) => {
      if (coordinates.length < 2) return [];
      const ext = (overlay.extendData ?? {}) as Partial<KaiBoxData>;
      if (ext.showLabels === false) return [];
      const isLong = ext.isLong !== false;
      const rr = ext.rr;
      const showTarget = rr != null && Number.isFinite(rr) && (rr as number) > 0;
      const rrVal = showTarget ? (rr as number) : 0;

      const entryY = coordinates[0].y;
      const dPix = Math.abs(coordinates[1].y - entryY);
      const hasStop = dPix > 0.5;
      const stopY = isLong ? entryY + dPix : entryY - dPix;
      const targetY = isLong ? entryY - rrVal * dPix : entryY + rrVal * dPix;

      const entryVal = overlay.points[0].value as number;
      const dVal = Math.abs(entryVal - (overlay.points[1].value as number));
      const stopVal = isLong ? entryVal - dVal : entryVal + dVal;
      const targetVal = isLong ? entryVal + rrVal * dVal : entryVal - rrVal * dVal;
      const pr = (precision as unknown as { price: number }).price;

      // Formatea igual que la escala nativa: separador de miles + `pr` decimales.
      const sep = thousandsSeparator || ',';
      const fmtPrice = (val: number) => {
        const [intPart, frac] = val.toFixed(pr).split('.');
        const withSep = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
        return frac ? `${withSep}.${frac}` : withSep;
      };

      const figs: OverlayFigure[] = [];
      const tag = (y: number, val: number, color: string) => {
        figs.push({
          type: 'rect',
          ignoreEvent: true,
          attrs: { x: 0, y: y - ROW_H / 2, width: bounding.width, height: ROW_H },
          styles: { style: 'fill', color, borderRadius: RADIUS },
        });
        figs.push({
          type: 'text',
          ignoreEvent: true,
          attrs: { x: bounding.width / 2, y, text: fmtPrice(val), align: 'center', baseline: 'middle' },
          styles: {
            size: AXIS_TAG_SIZE,
            family: AXIS_TAG_FONT,
            weight: 'normal',
            color: WHITE,
            paddingLeft: 0,
            paddingRight: 0,
            paddingTop: 0,
            paddingBottom: 0,
            borderSize: 0,
            backgroundColor: 'rgba(0,0,0,0)',
          },
        });
      };
      if (showTarget) tag(targetY, targetVal, COLOR_TARGET);
      if (hasStop) tag(stopY, stopVal, COLOR_STOP);
      return figs;
    },
  };
  registerOverlay(template);
}
