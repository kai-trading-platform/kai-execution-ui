/**
 * Fork Kai — herramienta PRICE RANGE (medición de rango de precio, estilo
 * TradingView).
 *
 * SOLO ANÁLISIS: 2 clicks definen una caja; muestra la diferencia de precio entre
 * el borde superior e inferior, el % de cambio y (si hay índice de velas) cuántas
 * velas abarca. Verde si el 2º punto quedó por encima del 1º (subida), rojo si por
 * debajo. Es un overlay de dibujo más (grupo `drawing_tools`, se persiste y se
 * borra con el resto).
 */

import { OverlayTemplate, LineAttrs, TextAttrs } from 'klinecharts'

const COLOR_UP = '#2ebd85'
const COLOR_DOWN = '#f6465d'
const FILL_UP = 'rgba(46,189,133,0.12)'
const FILL_DOWN = 'rgba(246,70,93,0.12)'
const FONT = 'JetBrains Mono, ui-monospace, monospace'

const priceRange: OverlayTemplate = {
  name: 'priceRange',
  totalStep: 3, // 2 clicks
  needDefaultPointFigure: true,
  needDefaultXAxisFigure: true,
  needDefaultYAxisFigure: true,
  createPointFigures: ({ coordinates, overlay, precision }) => {
    if (coordinates.length < 2) return []

    const x0 = coordinates[0].x
    const y0 = coordinates[0].y
    const x1 = coordinates[1].x
    const y1 = coordinates[1].y
    const leftX = Math.min(x0, x1)
    const rightX = Math.max(x0, x1)
    const topY = Math.min(y0, y1)
    const botY = Math.max(y0, y1)

    const v0 = overlay.points[0].value as number
    const v1 = overlay.points[1].value as number
    const delta = v1 - v0
    const pct = v0 !== 0 ? (delta / Math.abs(v0)) * 100 : 0
    const up = delta >= 0
    const color = up ? COLOR_UP : COLOR_DOWN
    const fill = up ? FILL_UP : FILL_DOWN
    const pr = (precision as unknown as { price: number }).price
    const sign = delta >= 0 ? '+' : '−'

    // Nº de velas abarcadas (si los puntos traen dataIndex).
    const d0 = (overlay.points[0] as { dataIndex?: number }).dataIndex
    const d1 = (overlay.points[1] as { dataIndex?: number }).dataIndex
    const bars =
      typeof d0 === 'number' && typeof d1 === 'number'
        ? Math.abs(Math.round(d1 - d0))
        : null

    const label = `${sign}${Math.abs(delta).toFixed(pr)}  (${sign}${Math.abs(
      pct,
    ).toFixed(2)}%)${bars != null ? `  ·  ${bars} velas` : ''}`
    const midX = (leftX + rightX) / 2

    const box = {
      coordinates: [
        { x: leftX, y: topY },
        { x: rightX, y: topY },
        { x: rightX, y: botY },
        { x: leftX, y: botY },
      ],
    }
    const topLine: LineAttrs = {
      coordinates: [
        { x: leftX, y: topY },
        { x: rightX, y: topY },
      ],
    }
    const botLine: LineAttrs = {
      coordinates: [
        { x: leftX, y: botY },
        { x: rightX, y: botY },
      ],
    }
    // Etiqueta centrada horizontalmente, sobre el borde superior de la caja.
    const text: TextAttrs = {
      x: midX,
      y: topY - 4,
      text: label,
      align: 'center',
      baseline: 'bottom',
    }

    return [
      // Relleno (click-through para no tapar las velas).
      { type: 'polygon', ignoreEvent: true, attrs: box, styles: { style: 'fill', color: fill } },
      // Bordes superior/inferior (interactivos: agarrarlos mueve la herramienta).
      { type: 'line', attrs: [topLine], styles: { color, size: 1 } },
      { type: 'line', attrs: [botLine], styles: { color, size: 1 } },
      // Etiqueta con Δprecio, % y velas.
      { type: 'text', ignoreEvent: true, attrs: [text], styles: { color, size: 12, family: FONT } },
    ]
  },
}

export default priceRange
