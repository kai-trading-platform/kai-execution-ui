// Caja de posición READ-ONLY para los trades de Kai (abiertos y cerrados), con el
// look del "Long/Short Position tool" de TradingView: zona verde (Entry→Target) y
// roja (Entry→Stop), líneas sólidas finas y etiquetas como PÍLDORAS redondeadas
// CENTRADAS sobre cada línea (TP verde, entrada neutra, SL rojo) — en vez de texto
// crudo pegado al borde izquierdo que se amontonaba sobre las velas.
//
// Es un overlay PROPIO (no la herramienta manual positionLong/Short): esa tiene
// `needDefaultPointFigure: true` → dibuja manijas/figuras AZULES por defecto que,
// en una caja read-only, tapan las zonas verde/rojo. Acá desactivamos todas las
// figuras default y controlamos el dibujo 100%. Además forzamos un ANCHO MÍNIMO
// para que un trade de segundos en un TF alto no quede como un sliver invisible.
//
// Puntos: [ {t0, entry}, {t1, stop} ]. La dirección y el target salen de
// extendData { isLong, rr }. Sin stop (point[1]==entry) → sólo línea de entrada.

import { registerOverlay } from 'klinecharts';
import type { OverlayFigure, OverlayTemplate } from 'klinecharts';

export const KAI_POSITION_BOX_NAME = 'kaiPositionBox';

// Paleta TradingView.
const COLOR_TARGET = '#2ebd85';
const COLOR_STOP = '#f6465d';
const COLOR_ENTRY_LINE = '#787b86'; // línea de entrada neutra (gris TV)
const FILL_TARGET = 'rgba(46,189,133,0.12)';
const FILL_STOP = 'rgba(246,70,93,0.12)';
// Píldora de entrada: fondo oscuro translúcido + borde tenue para leerse sobre velas.
const PILL_ENTRY_BG = 'rgba(23,27,38,0.92)';
const PILL_ENTRY_BORDER = 'rgba(255,255,255,0.16)';
const COLOR_ENTRY_TEXT = '#d1d4dc';
const FONT = 'JetBrains Mono, ui-monospace, monospace';
const MIN_WIDTH_PX = 96;

interface KaiBoxData {
  isLong: boolean;
  rr: number | null; // |tp-entry|/|entry-sl|; null si el trade no tiene TP
  // Sólo el trade ABIERTO muestra los pills TP/Entry/SL. Un trade CERRADO deja la
  // caja (zonas + líneas) como huella histórica, pero sin etiquetas que amontonen.
  showLabels?: boolean;
}

// Estilo base compartido de las píldoras (padding + radio = look TradingView).
const PILL_BASE = {
  size: 10,
  weight: 'bold' as const,
  family: FONT,
  paddingLeft: 6,
  paddingRight: 6,
  paddingTop: 3,
  paddingBottom: 3,
  borderRadius: 3,
};

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
    createPointFigures: ({ coordinates, overlay, precision }) => {
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
      const rightX = rawRight - leftX < MIN_WIDTH_PX ? leftX + MIN_WIDTH_PX : rawRight;
      const midX = (leftX + rightX) / 2; // píldoras centradas, como la herramienta de TV

      const entryVal = overlay.points[0].value as number;
      const dVal = Math.abs(entryVal - (overlay.points[1].value as number));
      const stopVal = isLong ? entryVal - dVal : entryVal + dVal;
      const targetVal = isLong ? entryVal + rrVal * dVal : entryVal - rrVal * dVal;
      const pr = (precision as unknown as { price: number }).price;

      const box = (y: number) => ({
        coordinates: [
          { x: leftX, y: entryY }, { x: rightX, y: entryY },
          { x: rightX, y }, { x: leftX, y },
        ],
      });

      const hLine = (y: number, color: string): OverlayFigure => ({
        type: 'line',
        ignoreEvent: true,
        attrs: [{ coordinates: [{ x: leftX, y }, { x: rightX, y }] }],
        styles: { color, style: 'solid', size: 1 },
      });

      // Píldora centrada sobre una línea: fondo relleno + texto blanco/tenue.
      const pill = (
        y: number,
        text: string,
        bg: string,
        color: string,
        border?: string,
      ): OverlayFigure => ({
        type: 'text',
        ignoreEvent: true,
        attrs: [{ x: midX, y, text, align: 'center', baseline: 'middle' }],
        styles: {
          ...PILL_BASE,
          color,
          backgroundColor: bg,
          ...(border ? { borderColor: border, borderSize: 1, borderStyle: 'solid' } : {}),
        },
      });

      const figs: OverlayFigure[] = [];

      // 1) Zonas (fill) — el orden importa: van al fondo.
      if (showTarget) {
        figs.push({ type: 'polygon', ignoreEvent: true, attrs: box(targetY), styles: { style: 'fill', color: FILL_TARGET } });
      }
      if (hasStop) {
        figs.push({ type: 'polygon', ignoreEvent: true, attrs: box(stopY), styles: { style: 'fill', color: FILL_STOP } });
      }

      // 2) Líneas de nivel + píldoras — SÓLO en el trade ABIERTO. El cerrado queda
      // como huella (zonas verde/roja), sin rayas horizontales ni etiquetas de
      // TP/SL/Entry que amontonen el chart con trades viejos.
      if (showLabels) {
        if (showTarget) figs.push(hLine(targetY, COLOR_TARGET));
        if (hasStop) figs.push(hLine(stopY, COLOR_STOP));
        figs.push(hLine(entryY, COLOR_ENTRY_LINE));

        if (showTarget) {
          figs.push(pill(targetY, `TP ${targetVal.toFixed(pr)} · +${rrVal.toFixed(1)}R`, COLOR_TARGET, '#ffffff'));
        }
        figs.push(pill(entryY, entryVal.toFixed(pr), PILL_ENTRY_BG, COLOR_ENTRY_TEXT, PILL_ENTRY_BORDER));
        if (hasStop) {
          figs.push(pill(stopY, `SL ${stopVal.toFixed(pr)} · −1R`, COLOR_STOP, '#ffffff'));
        }
      }

      return figs;
    },
  };
  registerOverlay(template);
}
