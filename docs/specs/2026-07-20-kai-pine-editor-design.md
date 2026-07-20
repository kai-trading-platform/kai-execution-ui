# Kai Pine — editor de indicadores con sintaxis Pine (fase 1)

**Fecha:** 2026-07-20 · **Estado:** aprobado por el usuario (chat)

## Objetivo

Pestaña **PINE** en el panel inferior del terminal (junto a CUENTAS/POSICIONES/ÓRDENES)
donde el usuario escribe indicadores con sintaxis Pine v5 (subset), los aplica al
chart y los guarda. Además: el terminal restaura su estado de UI al refrescar.

## Subset Pine fase 1

- `indicator("Título", overlay=true|false)` — opcional; default overlay=true.
- Series integradas: `open, high, low, close, volume, hl2, hlc3, ohlc4`.
- Historia con corchetes: `close[1]`, `miVar[2]`.
- Asignaciones `x = expr` (una por línea), comentarios `//`.
- Operadores: `+ - * / %`, comparaciones, `and or not`, ternario `c ? a : b`, paréntesis.
- `ta.*`: `ema, sma, wma, rsi, atr, stdev, highest, lowest, change, tr, crossover, crossunder`.
- `math.*`: `abs, max, min, round, floor, ceil, sqrt, pow, log`.
- `color.*`: constantes (`red, green, ...`) y `color.rgb(r,g,b[,a])`. Colores **constantes** en fase 1.
- `plot(expr, color=..., title=..., linewidth=...)`, `hline(nivel, color=..., title=...)`.
- Fuera de fase 1 (fase 2 futura): `input.*`, `plotshape`, `fill`, `if/for`, colores dinámicos.

## Arquitectura

`src/lib/pine/` — todo el compilador, sin dependencias nuevas:

- **`pineParser.ts`** — tokenizer + parser Pratt → AST. Errores con línea/columna.
- **`pineRuntime.ts`** — semántica de series de Pine: el script se evalúa barra a
  barra; cada call-site `ta.*` (nodo del AST) tiene su PROPIO estado (EMA previa,
  ventana rodante), igual que TradingView. `NaN` → `null` para klinecharts.
- **`compilePine.ts`** — API pública: `compilePine(source)` → `{ title, overlay,
  figures, calc }` listo para `registerIndicator` de klinecharts, o
  `{ error: { message, line } }`.
- **`examples.ts`** — plantillas (EMA cross, RSI, rango de apertura).
- **`pine.test.ts`** — vitest: parser (errores y precedencia), semántica ta.*
  contra valores calculados a mano, historia `[n]`, plots/overlay.

## Integración con el chart

- `src/lib/chartPro/chartInstance.ts` — registro singleton de la instancia
  klinecharts activa (patrón `setKaiPositionCloseHandler`). `KaiChartPro` la
  publica al montar y la limpia al desmontar.
- Aplicar script: `registerIndicator` (nombre estable `KAI_PINE_<scriptId>`) +
  `createIndicator(name, true, { id: 'candle_pane' })` si overlay, o pane nuevo.
- Actualizar: remove + re-register + create. Los indicadores sobreviven cambios
  de símbolo/TF (klinecharts recalcula solo). Al refrescar la página se
  re-aplican desde localStorage cuando el chart está listo.

## Persistencia (localStorage, patrón de la casa)

- `kai:pine:scripts` — `[{ id, name, source, updatedAt }]`.
- `kai:pine:applied` — ids de scripts aplicados al chart.
- Fase 2 opcional: mover scripts al servidor para seguir al usuario entre máquinas.

## UI de la pestaña PINE

Layout horizontal: lista de scripts (izquierda, ~180px) · editor (centro,
textarea monoespaciada con gutter de números de línea) · consola (abajo del
editor: error con línea o "Compilado · aplicado al chart"). Botones: **Nuevo**
(menú con plantillas), **Guardar**, **Añadir al chart / Actualizar**, **Quitar
del chart**, **Eliminar**.

## Estado de UI al refrescar

- `kai:bottomTab` — pestaña activa del panel inferior (incluye PINE).
- `kai:openSymbols:<accountId>` y `kai:selSymbol:<accountId>` — tabs de mercado
  y símbolo activo por cuenta; se hidratan al resolver la cuenta y los valida el
  efecto existente contra el catálogo (símbolos inválidos se descartan solos).
- Ya persistían: timeframe (`kai:timeframe`), panel de orden (`kai:orderPanelOpen`),
  ajustes (`kai:settings`), dibujos (`kai:drawings:<symbol>`), cuenta (URL).

## Errores

- Compilación: error en consola del editor con línea; el chart no se toca.
- Runtime por barra (p. ej. división rara): el valor de esa barra queda `null`;
  nunca rompe el chart (try/catch alrededor del calc completo → consola).

## Testing

- Unit (vitest): parser + runtime + compile (~30 casos).
- E2E (Playwright, en prod tras deploy): escribir script de plantilla, Añadir al
  chart, verificar línea nueva; refrescar y verificar tab PINE + script aplicado
  + símbolo/TF restaurados.
