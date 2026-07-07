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

      // Píxeles: Entry = 1er click; magnitud vertical del 2º click = riesgo.
      // La dirección se fuerza por el tipo (long = target arriba / short abajo).
      const entryY = coordinates[0].y
      const dPix = Math.abs(coordinates[1].y - entryY)
      const stopY = isLong ? entryY + dPix : entryY - dPix
      const targetY = isLong ? entryY - DEFAULT_RR * dPix : entryY + DEFAULT_RR * dPix
      const leftX = Math.min(coordinates[0].x, coordinates[1].x)
      const rightX = Math.max(coordinates[0].x, coordinates[1].x)

      // Valores (para las etiquetas de precio).
      const entryVal = overlay.points[0].value as number
      const dVal = Math.abs((overlay.points[0].value as number) - (overlay.points[1].value as number))
      const stopVal = isLong ? entryVal - dVal : entryVal + dVal
      const targetVal = isLong ? entryVal + DEFAULT_RR * dVal : entryVal - DEFAULT_RR * dVal
      const pr = (precision as unknown as { price: number }).price

      // Rectángulo entre el Entry y el nivel `y` (target o stop).
      const box = (y: number) => ({
        coordinates: [
          { x: leftX, y: entryY }, { x: rightX, y: entryY },
          { x: rightX, y }, { x: leftX, y }
        ]
      })

      const label = isLong ? 'LONG' : 'SHORT'
      const texts: TextAttrs[] = [
        { x: leftX + 4, y: targetY, text: `Target ${targetVal.toFixed(pr)}  ·  +${DEFAULT_RR.toFixed(1)}R`, baseline: 'bottom' },
        { x: leftX + 4, y: entryY, text: `${label} · Entry ${entryVal.toFixed(pr)}`, baseline: 'bottom' },
        { x: leftX + 4, y: stopY, text: `Stop ${stopVal.toFixed(pr)}  ·  −1R`, baseline: 'top' }
      ]

      const targetLine: LineAttrs = { coordinates: [{ x: leftX, y: targetY }, { x: rightX, y: targetY }] }
      const stopLine: LineAttrs = { coordinates: [{ x: leftX, y: stopY }, { x: rightX, y: stopY }] }
      const entryLine: LineAttrs = { coordinates: [{ x: leftX, y: entryY }, { x: rightX, y: entryY }] }

      // Zonas = click-through (ignoreEvent) para no tapar las velas debajo. El
      // arrastre del cuerpo se hace agarrando cualquiera de las 3 LÍNEAS (mueve
      // toda la herramienta, como TradingView); las 2 manijas (entry/stop)
      // ajustan cada nivel. El texto también ignora eventos.
      return [
        // Zonas (reward verde entry→target, risk roja entry→stop).
        { type: 'polygon', ignoreEvent: true, attrs: box(targetY), styles: { style: 'fill', color: FILL_TARGET } },
        { type: 'polygon', ignoreEvent: true, attrs: box(stopY), styles: { style: 'fill', color: FILL_STOP } },
        // Líneas (interactivas: agarrarlas mueve toda la herramienta).
        { type: 'line', attrs: [targetLine], styles: { color: COLOR_TARGET, style: 'dashed', size: 1 } },
        { type: 'line', attrs: [stopLine], styles: { color: COLOR_STOP, style: 'dashed', size: 1 } },
        { type: 'line', attrs: [entryLine], styles: { color: COLOR_ENTRY, size: 1 } },
        // Etiquetas.
        { type: 'text', ignoreEvent: true, attrs: [texts[0]], styles: { color: COLOR_TARGET, size: 11, family: FONT } },
        { type: 'text', ignoreEvent: true, attrs: [texts[1]], styles: { color: COLOR_ENTRY, size: 11, family: FONT } },
        { type: 'text', ignoreEvent: true, attrs: [texts[2]], styles: { color: COLOR_STOP, size: 11, family: FONT } }
      ]
    }
  }
}
