# Spec — Reskin AlphaTrader del terminal de futuros

Fecha: 2026-07-03 · Estado: diseño aprobado, pendiente ejecución por fases

## Objetivo
Llevar el look completo de la terminal de futuros de **AlphaTrader**
(`futures.alphatrader.com`) al terminal de Kai (`kai-execution-ui`, servido en
`terminal.scyra.dev/trading/terminal`). El chrome AlphaTrader aplica a **todo el
terminal**; el panel Order muestra la variante **contratos** para cuentas
futuros (Rithmic) y el ticket normal para CFD (MT5).

Referencia visual: `Downloads/MNQ (3_7_2026 22:57:38).html` (SingleFile de
AlphaTrader). Screenshots renderizados en scratchpad (`at-ref-top.png`,
`at-ref-wide.png`).

## Decisiones tomadas (usuario, 2026-07-03)
1. **Alcance:** layout completo AlphaTrader (no solo el chart).
2. **Panel Order:** funcional completo — REVERSE / FLATTEN ALL / CANCEL ALL como
   acciones reales contra el bridge Rithmic (money-adjacent, gated).
3. **Colores dirección:** mantener **verde alza / rojo baja** en velas y buy
   (NO el azul-buy de AlphaTrader). El chrome sí va casi-negro + acento azul.
4. **Alcance visual:** todo el terminal (una sola estética coherente).
5. **SSO:** track aparte. Diagnóstico entregado (ver apéndice); fix pendiente de OK.

## Hallazgo clave — el esqueleto YA coincide con AlphaTrader
`kai-execution-ui` es un monolito (`pages/TradingTerminal.tsx`, ~2004 líneas) con
sub-componentes inline: `TopHeader`, `MarketTabs`, `Watchlist`, `TradePanel`,
`BottomPanel`, `CloseAllDialog`. Su layout **ya es** header + watchlist izq +
chart centro + panel Order derecho + panel inferior con tabs. El `TradePanel` ya
es **futures-aware** (`strategy.mode === "futures"`, contratos enteros,
`tickSpec`, `maxContracts`). O sea: **re-skin + piezas puntuales, no build de
cero.**

Chart por defecto = `KaiChartPro` (`@klinecharts/pro`, fork en `vendor/`), flag
`VITE_CHART_PRO` (default true). Trae drawing bar nativa (`drawingBarVisible`) y
EMAs 10/20/55/200 ya configuradas — coincide con la toolbar izq y las EMAs de
AlphaTrader. Fallback `KaiChart`.

## Gap analysis (AlphaTrader → Kai hoy)
| AlphaTrader | Kai hoy | Acción |
|---|---|---|
| Header con fila de 5 stats | Header con mini-Equity a la derecha | **Agregar stats** |
| Toolbar dibujo izq | `drawingBarVisible` nativo ✅ | reusar |
| Chart + EMAs + eje con labels de color | KaiChartPro con EMAs ✅ | **recolorear** (`setStyles`) |
| Panel Order (contratos, flatten, reverse…) | `TradePanel` (ticket lotes/TP-SL) | **re-maquetar + wire** |
| Panel inferior Accounts/Positions/Orders/Trades | `BottomPanel` (Posiciones/Órdenes/Historial) | **restyle + tab Accounts** |
| Botones flotantes buy/sell + QUICK TRADE sobre chart | no existe | **overlay nuevo** |

## Paleta (chrome AlphaTrader, dirección verde/rojo)
Kai hoy usa navy `#0a0e16/#0b1019/#121826` + acento `#4c82e3` + verde `#2ed68d` /
rojo `#ef5350`. AlphaTrader es casi-negro con azul royal de acento. Target:
- Fondo app/chart: casi-negro azulado (≈ `#05070c` / `#0a0c12`).
- Paneles/headers/popovers: `#0d0f16` / `#12141c`.
- Inputs/chips: `#151824`.
- Acento (tabs activas, selección, qty activa): azul royal `#2f6bff` (reemplaza `#4c82e3`).
- **Dirección (sin cambio):** buy/alza verde `#2ed68d`, sell/baja rojo `#ef5350`.
- Bordes: `border-white/8`.

Los tokens viven en `index.css` (HSL vars) **pero el terminal hardcodea hex** en
`TradingTerminal.tsx` / `KaiChart.tsx` — hay que tocar **ambos**: tokens HSL +
los hex literales + las custom props `.klinecharts-pro[data-theme="dark"]`
(`index.css:591`). Fuente: mantener IBM Plex Sans/Mono (ya está).

## Cadena de ejecución de órdenes (money-critical)
`terminal → kai-execution-api → kai-backend → kai-rithmic-bridge`. **Dos
kill-switches** `RITHMIC_TERMINAL_ORDERS_ENABLED` (adapter + controller, default
OFF) + clamp `autotrading:maxContracts:<id>` + gate de riesgo por trade
fail-closed en el path de place. **Todo esto se respeta; el reskin no lo bypassea.**

## Matriz de capacidades del panel Order (F3)
| Acción | Estado | Trabajo |
|---|---|---|
| BUY/SELL @ MARKET (+bracket) | ✅ full-stack (`usePlaceTradingOrder`) | reusar |
| CLOSE POSITION (una) | ✅ full-stack (`useCloseTradingPosition`) | reusar |
| FLATTEN ALL | ⚠️ hoy = loop client-side (`CloseAllDialog`) | exponer `close_all()` atómico del bridge (cierra todo + cancela órdenes): `/api/trading/positions/close-all` → backend → adapter |
| CANCEL ALL | ⚠️ bridge `/orders/cancel-all` listo, no cableado | wire: backend `/internal/rithmic/orders/cancel-all` + adapter + api + hook |
| REVERSE POSITION | ❌ no existe | **fn atómica nueva en el bridge** (close + open opuesto). Client-side compose tiene ventana en flat + re-clamp del risk-gate |
| Working orders (grid pendientes) | ❌ sin read-path | **DIFERIDO** (Positions/Trades ya andan) |
| OCO/Bracket + modify stops + partial | ✅ cableado | reusar |

Semántica de tamaño: futuros = contratos enteros, cap + risk enforced server-side. Ya resuelto.

## Fases (Fase A shippea sola sin riesgo de dinero)

### Fase A — Visual (cero dinero)
- **A1 Paleta/chrome:** tokens `index.css` + hex hardcodeados + `.klinecharts-pro`
  vars → paleta AlphaTrader. `setStyles()` en `chartRef.current.getChart()`
  (`KaiChartPro.tsx:210`, hoy ausente — inserción limpia) para velas
  (verde/rojo), grilla, crosshair, eje con labels de precio coloreados.
- **A2 Header stats:** fila CURRENT BALANCE / EQUITY / NET DAILY PNL /
  UNREALIZED PNL / SOD BALANCE. Equity ya existe; PnL diario, no-realizado y SOD
  hay que derivarlos de cuenta/posiciones (ver riesgo de datos).
- **A3 Panel Order re-maquetado:** CONTRACTS (dropdown símbolo), ORDER TYPE,
  # OF CONTRACTS, quick-qty `− 1 3 5 10 15 +`, Bid/Ask, toggle OCO/Bracket,
  BUY/SELL @ MARKET. Reusa place/close existentes. CLOSE funciona ya;
  REVERSE/FLATTEN/CANCEL se maquetan **deshabilitados** ("Próximamente") hasta B.
- **A4 Overlays sobre chart:** QUICK TRADE flotante + botones buy/sell (inserción
  en el wrapper `relative` de `KaiChartPro.tsx:300`, reusa `handlePlaceOrder` +
  `bidPrice`/`askPrice` ya en scope). Toggle "Trade Arrows".
- **A5 Panel inferior:** restyle tabla + tab Accounts (lista de cuentas del provider).

### Fase B — Acciones funcionales (money-adjacent, gated + verificación)
- **B1 FLATTEN ALL atómico:** exponer `close_all` del bridge por las 3 capas.
- **B2 CANCEL ALL:** cablear `/orders/cancel-all` (bridge listo) por las 3 capas + hook.
- **B3 REVERSE atómico** en el bridge (con clamp `maxContracts` + risk-gate explícitos).
- **B4 (diferido):** working-orders read-path en 3 capas → grid de pendientes.

Cada acción de B respeta ambos kill-switches y se valida contra bridge real
antes de habilitarse. Ship de B **después** de A.

## Reusar (no reconstruir)
`usePlaceTradingOrder`, `useCloseTradingPosition`, `useUpdateTradingPositionStops`,
`useTradingPositions`, `MarketSocketContext` (ticks bid/ask), `strategy`/`tickSpec`/
`maxContracts` (sizing futuros), `CloseAllDialog` (base de FLATTEN), drawing bar
nativa de klinecharts-pro, EMAs ya configuradas.

## Blast radius / riesgos
- **Datos de header (A2):** NET DAILY PNL / SOD BALANCE / UNREALIZED PNL pueden
  no existir tal cual — hay que confirmar de dónde salen (cuenta vs suma de
  posiciones vs backend). Si falta SOD, degradar elegante (—) en vez de inventar.
- **Hex hardcodeados:** cambiar solo los tokens NO alcanza; hay que barrer los
  literales en `TradingTerminal.tsx`/`KaiChart.tsx`. Riesgo de dejar zonas con la
  paleta vieja → revisión visual pantalla por pantalla.
- **Fork klinecharts-pro:** `setStyles()` sobre el fork — verificar que la API
  `getChart().setStyles()` exista/funcione en el fork (`vendor/`) y no rompa
  overlays de posición existentes (`KaiChartPro.tsx:284-296`).
- **REVERSE (B3):** money-critical. Preferir atómico en bridge; el compose
  client-side deja ventana en flat y el re-entry re-pasa por clamp/risk-gate
  (podría quedar flat en vez de revertido).
- **Kill-switches:** REVERSE/FLATTEN/CANCEL deben quedar deshabilitados si el
  flag de la cuenta no vuelve true (igual que BUY/SELL hoy, `TradingTerminal.tsx:506`).
- **Coherencia CFD:** el chrome aplica a todo; verificar que el ticket CFD (lotes,
  MERCADO/LIMITE/STOP) siga legible con la paleta nueva.
- **Proxy :5174 / Caddy:** nuevos endpoints `/api/trading/positions/close-all`,
  `/api/trading/orders/cancel-all` deben matchear antes que `/api` en el proxy
  (gotcha conocido); espejar en Caddy prod + restart.

## Archivos ancla
`kai-execution-ui`: `pages/TradingTerminal.tsx` (TopHeader/TradePanel/BottomPanel/
CloseAllDialog inline), `components/KaiChartPro.tsx` (setStyles, overlays),
`components/KaiChart.tsx` (`CHART_STYLES:130`), `index.css` (tokens +
`.klinecharts-pro:591`), `tailwind.config.ts`, `api/trading.ts`,
`hooks/{usePlaceTradingOrder,useCloseTradingPosition,useTradingPositions}.ts`,
`contexts/MarketSocketContext.tsx`.
`kai-execution-api`: `controller.ts`, `adapters/rithmic/rithmic-broker.adapter.ts`,
`adapters/rithmic/kai-backend.client.ts`.
`kai-backend`: `rithmic/internal-rithmic.controller.ts`, `rithmic-execution.service`.
`kai-rithmic-bridge`: `rithmic-bridge/main.py` (`close_all`/`cancel-all`/reverse nuevo),
`rithmic_client.py`.

---

## Apéndice — Diagnóstico SSO (track aparte, sin implementar)
**Problema:** la terminal a veces pide login aunque Kai esté logueado; los tokens
"expiran distinto".

**Causa:** las dos apps nunca compartieron sesión.
- **RC1** — cookie de refresh **host-only** (sin `Domain=.scyra.dev`) en
  `auth.controller.ts:145-159` → la cookie de `api.scyra.dev` nunca llega a
  `terminal.scyra.dev`.
- **RC2** — el único puente es una **copia de token de 30s** (`kai_sso`,
  `openTerminal.ts:33-40` → `main.tsx:25-40`); la rotación con revocación
  (`auth.service.ts:104-135`) desincroniza las copias dentro de un ciclo de 15
  min. Además la terminal manda el `refreshToken` en el body y el handler lo
  prefiere sobre la cookie (`auth.controller.ts:65`).
- **RC3** — access TTL 15 min + refresh solo reactivo (on-401) amplifica.
- **Descartado:** CORS (la terminal es same-origin vía proxy Vite).

**Fix recomendado (backend + terminal, money-adjacent):**
1. Cookie `Domain=.scyra.dev` (vía env `COOKIE_DOMAIN`) en `attachRefreshCookie`
   y los `clearCookie`.
2. Terminal confía solo en la cookie compartida: `{}` en `/refresh`, dejar de
   persistir/mandar `refreshToken` en el body (`client.ts:144-149`).
3. (Opcional) refresh proactivo (decodificar `exp`, refrescar ~1 min antes).

**Landmines:** `JWT_REFRESH_TTL` en `.env` no se lee (código lee
`JWT_REFRESH_TTL_LONG/SHORT`, ausentes → defaults 30d/1d); `JWT_ACCESS_TTL`
difiere entre archivos (15m vs 4h).
