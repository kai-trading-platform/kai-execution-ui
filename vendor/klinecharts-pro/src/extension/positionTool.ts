/**
 * Fork Kai — herramientas de posición LONG / SHORT (estilo TradingView).
 *
 * SOLO ANÁLISIS: dibuja una caja Entry / Target / Stop con zonas verde
 * (reward) y roja (risk) y el múltiplo R. NO ejecuta órdenes ni toca el panel
 * de orden; es un overlay de dibujo más (grupo `drawing_tools`, se persiste y
 * se borra con el resto).
 *
 * Creación: 2 clicks. El primero fija el Entry + borde izquierdo; el segundo
 * fija el borde derecho y, por su distancia vertical al Entry, el RIESGO (Stop).
 * El Target se deriva a `RR` veces el riesgo hacia el lado favorable. La
 * dirección (arriba para LONG, abajo para SHORT) se fuerza por el tipo de
 * herramienta, así el dibujo siempre es coherente sin importar hacia dónde se
 * arrastre. Entry y Stop son manijas arrastrables (recalculan todo).
 */

import { OverlayTemplate, LineAttrs, TextAttrs } from 'klinecharts'

/** Riesgo:beneficio por defecto (Target = RR × riesgo). */
const DEFAULT_RR = 2

const COLOR_ENTRY = '#d1d4dc'
const COLOR_TARGET = '#2ebd85'
const COLOR_STOP = '#f6465d'
const FILL_TARGET = 'rgba(46,189,133,0.10)'
const FILL_STOP = 'rgba(246,70,93,0.10)'
const FONT = 'JetBrains Mono, ui-monospace, monospace'

type Side = 'long' | 'short'

export function createPositionTemplate (side: Side): OverlayTemplate {
  const isLong = side === 'long'
  return {
    name: isLong ? 'positionLong' : 'positionShort',
    totalStep: 3,
    needDefaultPointFigure: true,
    needDefaultXAxisFigure: true,
    needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates, overlay, precision }) => {
      if (coordinates.length < 2) return []

      // Modo AUTO (trades de Kai): el overlay trae `extendData` con el múltiplo R
      // REAL del trade (rr) y una etiqueta. `rr === null` → sin zona de target
      // (posición sin TP). En creación manual no hay extendData → RR por defecto.
      const ext = (overlay.extendData ?? {}) as {
        rr?: number | null
        entryNote?: string
      }
      const hasExt = overlay.extendData != null && 'rr' in ext
      const rr = hasExt ? ext.rr : DEFAULT_RR
      const showTarget = rr != null && Number.isFinite(rr)
      const rrVal = showTarget ? (rr as number) : DEFAULT_RR

      // Píxeles: Entry = 1er click; magnitud vertical del 2º click = riesgo.
      // La dirección se fuerza por el tipo (long = target arriba / short abajo).
      const entryY = coordinates[0].y
      const dPix = Math.abs(coordinates[1].y - entryY)
      const stopY = isLong ? entryY + dPix : entryY - dPix
      const targetY = isLong ? entryY - rrVal * dPix : entryY + rrVal * dPix
      const leftX = Math.min(coordinates[0].x, coordinates[1].x)
      const rawRight = Math.max(coordinates[0].x, coordinates[1].x)
      // Ancho mínimo visible para los trades de Kai (auto, con extendData): un
      // trade de segundos en un TF alto (p.ej. 1m en 1h) sería un sliver de ~2px
      // y no se verían las zonas/líneas de Entry/TP/SL. Forzamos un ancho mínimo
      // para que la caja siempre muestre los niveles. El dibujo manual no se toca.
      const MIN_AUTO_WIDTH_PX = 96
      const rightX =
        hasExt && rawRight - leftX < MIN_AUTO_WIDTH_PX
          ? leftX + MIN_AUTO_WIDTH_PX
          : rawRight

      // Valores (para las etiquetas de precio).
      const entryVal = overlay.points[0].value as number
      const dVal = Math.abs((overlay.points[0].value as number) - (overlay.points[1].value as number))
      const stopVal = isLong ? entryVal - dVal : entryVal + dVal
      const targetVal = isLong ? entryVal + rrVal * dVal : entryVal - rrVal * dVal
      const pr = (precision as unknown as { price: number }).price

      // Rectángulo entre el Entry y el nivel `y` (target o stop).
      const box = (y: number) => ({
        coordinates: [
          { x: leftX, y: entryY }, { x: rightX, y: entryY },
          { x: rightX, y }, { x: leftX, y }
        ]
      })

      // Los trades de Kai (auto, traen extendData) NO muestran la palabra
      // LONG/SHORT — se ven como un trade normal (Entry/Target/Stop). La creación
      // manual (sin extendData) sí conserva la etiqueta LONG/SHORT.
      const label = hasExt ? '' : isLong ? 'LONG' : 'SHORT'
      const entryPrefix = label ? `${label} · ` : ''
      const entryText = ext.entryNote
        ? `${entryPrefix}Entry ${entryVal.toFixed(pr)} · ${ext.entryNote}`
        : `${entryPrefix}Entry ${entryVal.toFixed(pr)}`
      const texts: TextAttrs[] = [
        { x: leftX + 4, y: targetY, text: `Target ${targetVal.toFixed(pr)}  ·  +${rrVal.toFixed(1)}R`, baseline: 'bottom' },
        { x: leftX + 4, y: entryY, text: entryText, baseline: 'bottom' },
        { x: leftX + 4, y: stopY, text: `Stop ${stopVal.toFixed(pr)}  ·  −1R`, baseline: 'top' }
      ]

      const targetLine: LineAttrs = { coordinates: [{ x: leftX, y: targetY }, { x: rightX, y: targetY }] }
      const stopLine: LineAttrs = { coordinates: [{ x: leftX, y: stopY }, { x: rightX, y: stopY }] }
      const entryLine: LineAttrs = { coordinates: [{ x: leftX, y: entryY }, { x: rightX, y: entryY }] }

      // Zonas = click-through (ignoreEvent) para no tapar las velas debajo. El
      // arrastre del cuerpo se hace agarrando cualquiera de las 3 LÍNEAS (mueve
      // toda la herramienta, como TradingView); las 2 manijas (entry/stop)
      // ajustan cada nivel. El texto también ignora eventos. La zona/línea/label
      // de target se omiten cuando el trade no tiene TP (rr === null).
      return [
        // Zonas (reward verde entry→target, risk roja entry→stop).
        ...(showTarget ? [{ type: 'polygon' as const, ignoreEvent: true, attrs: box(targetY), styles: { style: 'fill' as const, color: FILL_TARGET } }] : []),
        { type: 'polygon', ignoreEvent: true, attrs: box(stopY), styles: { style: 'fill', color: FILL_STOP } },
        // Líneas (interactivas: agarrarlas mueve toda la herramienta).
        ...(showTarget ? [{ type: 'line' as const, attrs: [targetLine], styles: { color: COLOR_TARGET, style: 'dashed' as const, size: 1 } }] : []),
        { type: 'line', attrs: [stopLine], styles: { color: COLOR_STOP, style: 'dashed', size: 1 } },
        { type: 'line', attrs: [entryLine], styles: { color: COLOR_ENTRY, size: 1 } },
        // Etiquetas.
        ...(showTarget ? [{ type: 'text' as const, ignoreEvent: true, attrs: [texts[0]], styles: { color: COLOR_TARGET, size: 11, family: FONT } }] : []),
        { type: 'text', ignoreEvent: true, attrs: [texts[1]], styles: { color: COLOR_ENTRY, size: 11, family: FONT } },
        { type: 'text', ignoreEvent: true, attrs: [texts[2]], styles: { color: COLOR_STOP, size: 11, family: FONT } }
      ]
    }
  }
}
