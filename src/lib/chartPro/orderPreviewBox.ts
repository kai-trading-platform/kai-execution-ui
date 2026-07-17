// Preview de orden EDITABLE (estilo Exness/TradingView): líneas de precio de TP y
// SL ARRASTRABLES (se agarra la línea en cualquier punto, no un handle diminuto) +
// una línea de entrada estática (precio actual). Al arrastrar un nivel aparece la
// SOMBRA verde (entry→TP) / roja (entry→SL) para ver "desde dónde" va — en reposo
// solo se ven las líneas. SÓLO PREVIEW: no ejecuta nada hasta pulsar BUY/SELL.
//
// Por qué 3 overlays de 1 punto (y no 1 overlay de 3 puntos): en klinecharts un
// overlay solo entra en modo "arrastrar" si el puntero cae sobre una figura que NO
// sea ignoreEvent. Con un único punto, agarrar la línea = mover ESE precio (como el
// priceLine nativo). Con 3 puntos, agarrar una línea trasladaría los tres juntos.
//
// - orderEntryLine  : 1 punto, lock:true, gris sólida, label "Entry <precio>". Estática.
// - orderLevelLine  : 1 punto, draggable. extendData { kind:'tp'|'sl', entryValue }.
//   La app registra setOrderLevelChangeHandler para recibir (kind, value, phase) y
//   sincronizar el formulario; el template setea setOrderPreviewDragging para la sombra.

import { registerOverlay } from 'klinecharts';
import type { OverlayFigure, OverlayTemplate } from 'klinecharts';

export const ORDER_ENTRY_LINE_NAME = 'orderEntryLine';
export const ORDER_LEVEL_LINE_NAME = 'orderLevelLine';

const COLOR_TP = '#089981';
const COLOR_SL = '#f23645';
const COLOR_ENTRY = '#9598a1';
const FILL_TP = 'rgba(8,153,129,0.15)';
const FILL_SL = 'rgba(242,54,69,0.15)';
const LABEL_BG = 'rgba(20,22,28,0.88)';
const WHITE = '#ffffff';
const AXIS_TAG_FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';
const ROW_H = 20;
const AXIS_GAP = 2;

// ── Estado de arrastre (para pintar la sombra solo del overlay que se mueve) ────
// Token = `${ticket ?? 'order'}:${kind}` — así arrastrar el SL de UNA posición no
// sombrea el SL de otra ni el de la orden nueva.
let draggingToken: string | null = null;
function dragToken(ticket: string | undefined, kind: 'tp' | 'sl'): string {
  return `${ticket ?? 'order'}:${kind}`;
}
export function setOrderPreviewDragging(token: string | null): void {
  draggingToken = token;
}

// ── Handler que la app registra para recibir los cambios de nivel al arrastrar ──
// ticket presente = SL/TP de una POSICIÓN ABIERTA (modificar en el bróker);
// ausente = preview de orden NUEVA (sincronizar el formulario).
type LevelChange = (
  kind: 'tp' | 'sl',
  value: number,
  phase: 'move' | 'end',
  ticket?: string,
) => void;
let levelChangeHandler: LevelChange | null = null;
export function setOrderLevelChangeHandler(fn: LevelChange | null): void {
  levelChangeHandler = fn;
}

// Pill de etiqueta a la DERECHA (junto al eje), texto de color sobre fondo oscuro.
function rightLabel(axisX: number, y: number, text: string, color: string): OverlayFigure {
  return {
    type: 'text',
    ignoreEvent: true,
    attrs: { x: axisX - 4, y, text, align: 'right', baseline: 'middle' },
    styles: {
      color,
      size: 11,
      family: AXIS_TAG_FONT,
      weight: 'bold',
      backgroundColor: LABEL_BG,
      borderRadius: 2,
      paddingLeft: 5,
      paddingRight: 5,
      paddingTop: 3,
      paddingBottom: 3,
    },
  };
}

// Tag de precio incrustado en el eje Y (verde/rojo/gris) al nivel de la línea.
function axisTag(bounding: { width: number }, y: number, text: string, color: string): OverlayFigure[] {
  return [
    {
      type: 'rect',
      ignoreEvent: true,
      attrs: { x: 0, y: y - ROW_H / 2, width: bounding.width, height: ROW_H },
      styles: { style: 'fill', color, borderRadius: 2 },
    },
    {
      type: 'text',
      ignoreEvent: true,
      attrs: { x: bounding.width / 2, y, text, align: 'center', baseline: 'middle' },
      styles: { size: 12, family: AXIS_TAG_FONT, color: WHITE },
    },
  ];
}

function fmtPrice(v: number, pr: number, sep: string): string {
  const [i, f] = v.toFixed(pr).split('.');
  const s = i.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return f ? `${s}.${f}` : s;
}

let registered = false;

export function registerOrderPreviewBoxOverlay(): void {
  if (registered) return;
  registered = true;

  // ── Línea de ENTRADA (estática, no arrastrable) ───────────────────────────────
  const entryTemplate: OverlayTemplate = {
    name: ORDER_ENTRY_LINE_NAME,
    totalStep: 2, // 1 punto
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay, precision, bounding }) => {
      if (coordinates.length < 1) return [];
      const y = coordinates[0].y;
      const val = overlay.points[0].value as number;
      const pr = (precision as unknown as { price: number }).price;
      const axisX = bounding.width - AXIS_GAP;
      return [
        {
          type: 'line',
          ignoreEvent: true,
          attrs: { coordinates: [{ x: 0, y }, { x: axisX, y }] },
          styles: { color: COLOR_ENTRY, style: 'solid', size: 1 },
        },
        rightLabel(axisX, y, `Entry ${val.toFixed(pr)}`, WHITE),
      ];
    },
  };

  // ── Línea de NIVEL (TP/SL) arrastrable ────────────────────────────────────────
  const levelTemplate: OverlayTemplate = {
    name: ORDER_LEVEL_LINE_NAME,
    totalStep: 2, // 1 punto
    needDefaultPointFigure: false, // se agarra la línea, no un handle
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    // Al arrastrar (klinecharts ya movió el punto) avisamos a la app y marcamos la
    // sombra. Devolvemos false para no persistir como dibujo.
    onPressedMoving: (event) => {
      const ext = (event.overlay?.extendData ?? {}) as { kind?: 'tp' | 'sl'; ticket?: string };
      const kind = ext.kind;
      const value = event.overlay?.points?.[0]?.value as number | undefined;
      if (kind && Number.isFinite(value)) {
        setOrderPreviewDragging(dragToken(ext.ticket, kind));
        levelChangeHandler?.(kind, value as number, 'move', ext.ticket);
      }
      return false;
    },
    onPressedMoveEnd: (event) => {
      const ext = (event.overlay?.extendData ?? {}) as { kind?: 'tp' | 'sl'; ticket?: string };
      const kind = ext.kind;
      const value = event.overlay?.points?.[0]?.value as number | undefined;
      if (kind && Number.isFinite(value)) {
        levelChangeHandler?.(kind, value as number, 'end', ext.ticket);
      }
      setOrderPreviewDragging(null);
      return false;
    },
    createPointFigures: ({ coordinates, overlay, precision, bounding, yAxis }) => {
      if (coordinates.length < 1) return [];
      const ext = (overlay.extendData ?? {}) as {
        kind?: 'tp' | 'sl';
        entryValue?: number;
        ticket?: string;
      };
      const kind = ext.kind ?? 'tp';
      const isTp = kind === 'tp';
      const color = isTp ? COLOR_TP : COLOR_SL;
      const fill = isTp ? FILL_TP : FILL_SL;
      const y = coordinates[0].y;
      const val = overlay.points[0].value as number;
      const entryVal = ext.entryValue;
      const pr = (precision as unknown as { price: number }).price;
      const axisX = bounding.width - AXIS_GAP;

      const figs: OverlayFigure[] = [];

      // Sombra SOLO mientras se arrastra ESTE overlay (token): banda de ancho
      // completo desde la entrada (convertida a pixel) hasta la línea.
      if (draggingToken === dragToken(ext.ticket, kind) && Number.isFinite(entryVal)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const conv = (yAxis as any)?.convertToPixel;
        const entryY = typeof conv === 'function' ? conv.call(yAxis, entryVal) : null;
        if (entryY != null && Number.isFinite(entryY)) {
          figs.push({
            type: 'polygon',
            ignoreEvent: true,
            attrs: {
              coordinates: [
                { x: 0, y: entryY }, { x: axisX, y: entryY },
                { x: axisX, y }, { x: 0, y },
              ],
            },
            styles: { style: 'fill', color: fill },
          });
        }
      }

      // Línea de nivel: ARRASTRABLE (ignoreEvent:false) para poder agarrarla.
      figs.push({
        type: 'line',
        ignoreEvent: false,
        attrs: { coordinates: [{ x: 0, y }, { x: axisX, y }] },
        styles: { color, style: 'dashed', size: 1, dashedValue: [4, 3] },
      });

      // Etiqueta a la derecha SOLO para la orden nueva; en posiciones abiertas
      // (con ticket) las etiquetas y el tag del eje los pone kaiPositionBox → aquí
      // solo la línea draggable + la sombra, para no duplicar.
      if (!ext.ticket) {
        const dist = Number.isFinite(entryVal)
          ? `  ${isTp ? '+' : '-'}${Math.abs(val - (entryVal as number)).toFixed(pr)}`
          : '';
        figs.push(rightLabel(axisX, y, `${isTp ? 'TP' : 'SL'}${dist}`, color));
      }
      return figs;
    },
    createYAxisFigures: ({ coordinates, overlay, precision, bounding, thousandsSeparator }) => {
      if (coordinates.length < 1) return [];
      const ext = (overlay.extendData ?? {}) as { kind?: 'tp' | 'sl'; ticket?: string };
      // El tag del eje de una posición abierta lo dibuja kaiPositionBox.
      if (ext.ticket) return [];
      const color = ext.kind === 'sl' ? COLOR_SL : COLOR_TP;
      const val = overlay.points[0].value as number;
      const pr = (precision as unknown as { price: number }).price;
      return axisTag(bounding, coordinates[0].y, fmtPrice(val, pr, thousandsSeparator || ','), color);
    },
  };

  registerOverlay(entryTemplate);
  registerOverlay(levelTemplate);
}
