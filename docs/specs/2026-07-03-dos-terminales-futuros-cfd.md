# Spec — Dos terminales: Futuros (Rithmic/Apex) + CFD (MT5)

Fecha: 2026-07-03 · Estado: diseño aprobado, pendiente ejecución por fases

## Objetivo
Partir el terminal único (`kai-execution-ui`) en dos experiencias: **Futuros**
(contratos, ejecución vía Rithmic/Apex) y **CFD** (lotes, vía el bridge MT5
actual). Hoy es un solo terminal cableado end-to-end a MT5.

## Estado actual (hallazgo clave)
`kai-execution-ui` es un monolito (`TradingTerminal.tsx`, ~1875 líneas) cableado a
MT5: `provider` hardcodeado `"mt5"`, cuentas/posiciones/órdenes por
`kai-execution-api`, símbolos/velas/ticks por `kai-backend`. **Rithmic no tiene
superficie interactiva**: `RithmicModule` es solo servicios (sin controller, el
gateway de ticks rechaza cuentas no-MT5). Por eso el trabajo es **~30% refactor
de front y ~70% API nueva de backend para Rithmic**. El front ya está bien
encaminado (datafeed provider-agnóstico con `accountId`+`ticker`; execution-api
tiene `BrokerAdapter`/`BrokerRegistry` con solo `mt5` registrado).

## Diferencias reales Futuros vs CFD
| Dimensión | CFD (MT5, hoy) | Futuros (Rithmic, nuevo) |
|---|---|---|
| Unidad | Lotes, paso 0.01 | **Contratos, entero, paso 1** |
| Sizing | `riskUsd / slDist` (naive) | `floor(riskUsd / (slTicks × tickValue))` |
| Cap | — | `autotrading:maxContracts:<id>` (Apex=1) |
| Símbolos | ~355 MT5 (account_symbols) | roots Rithmic + front-month |
| Routing | execution-api → Mt5BrokerAdapter | RithmicExecutionService |
| tick/point value | AccountSymbol | futures-registry / account_symbols |
| Horas | forex/index | RTH gate CME + feriados |
| Cuenta | `mt5_accounts` | `rithmic_accounts` |
Todo lo demás (chart, watchlist, alertas, settings, auth/SSO, order modes,
tabla de posiciones) es idéntico y se comparte.

## Enfoque elegido: **B sobre el mecanismo de A**
Dos rutas para UX/deep-link (`/trading/futures`, `/trading/cfd`), pero ambas
renderizan un shell compartido cuyo comportamiento lo dirige un `terminalMode`
derivado del `provider` de la cuenta. Menos duplicación + URLs limpias + fuerza
la descomposición del monolito. (Rechazado: 2 apps separadas = duplica chart/fork
klinecharts-pro/auth/SSO/proxy.)

## Secuencia de build (cada paso es shippable)
1. **Backend: cuentas provider-transparentes.** Unir `rithmic_accounts` en
   `GET /api/trading/accounts` con `provider` correcto (hoy hardcodea `'mt5'` en
   execution-api `query.service.ts`). → el terminal LISTA cuentas de futuros.
2. **Frontend: `TerminalMode` + strategy object, sin cambio de comportamiento**
   para MT5. Descomponer el monolito detrás de esto (TopHeader, Watchlist,
   OrderTicket, PositionsPanel, dialogs) tomando `mode`/`strategy` por prop.
3. **Backend: posiciones + símbolos + rates de Rithmic** vía `RithmicBrokerAdapter`
   en execution-api (delegando a `RithmicExecutionService`/`RithmicDataService`) +
   endpoints `/rates`/`/symbols` (o `/api/market/:accountId/...` neutral).
4. **Frontend: strategy de futuros** (contratos, sizing por tickValue, cap
   maxContracts, label "Contratos"). Read-only + preview de sizing.
5. **Backend + frontend: tick stream de futuros** (extender auth del
   `market-data.gateway.ts:105`, hoy solo `mt5Account`) + **habilitar órdenes**
   Rithmic por el `/api/trading/orders` transparente (detrás de flag por cuenta).
6. **Rutas** `/trading/futures` + `/trading/cfd`, selectores filtrados por
   provider, actualizar deep-links de kai-frontend.

## Reusar (no reconstruir)
`BrokerRegistryService`/`BrokerAdapter` (execution-api), `KaiDatafeed`
(provider-agnóstico), `account-symbol-specs.ts` + `futures-registry.ts` (specs y
sizing de futuros ya existen en backend), resolución de `?account=`.

## Blast radius / riesgos
- **Backend es el palo largo**, no el front (Rithmic sin API interactiva hoy).
- `market-data.gateway.ts:105` autoriza solo `mt5Account` → un id Rithmic falla
  silencioso; extender + re-testear aislamiento por tenant.
- **Orden del proxy :5174** (gotcha): `/api/trading` debe matchear antes que
  `/api`; espejar en Caddy de prod (restart tras editar).
- **Fork klinecharts-pro** (`vendor/klinecharts-pro`, alias en vite): el datafeed
  se comparte; futuros solo necesita `/rates` con el mismo shape OHLC. Re-verificar
  overlays/decimales con tick sizes chicos (SI/HG 0.005/0.0005).
- **Auth/SSO**: 1 app = 1 handoff `kai_sso`. Mantener `/trading/terminal` como
  redirect que infiere mode del provider de `?account=` (no romper deep-links).
- **Sizing de futuros**: el `riskUsd/slDist` actual es INCORRECTO para futuros
  (ignora tickValue). Usar futures-registry + honrar cap Apex + revisar contra el
  risk-guard del backend para que el terminal no bypasee límites del ejecutor.

## Archivos ancla
`kai-execution-ui`: `pages/TradingTerminal.tsx`, `types/trading.ts`,
`config/routes.ts`, `hooks/useAccountSymbols.ts`,
`modules/copyTrading/hooks/useMarketCandles.ts`, `contexts/MarketSocketContext.tsx`,
`lib/chartPro/KaiDatafeed.ts`, `vite.config.ts`.
`kai-execution-api`: `core/{types,broker-registry.service,broker-adapter.interface}.ts`,
`query.service.ts`, `controller.ts`.
`kai-backend`: `rithmic/{rithmic.module,futures-registry,account-symbol-specs,rithmic-execution.service,rithmic-data.service}.ts`,
`mt5-accounts/mt5-accounts.controller.ts`, `market-data/market-data.gateway.ts`.
