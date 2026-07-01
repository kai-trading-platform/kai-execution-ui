# Integración TradingView Advanced Charts (pendiente de acceso al repo)

Estado: **esperando aprobación de TradingView**. El Datafeed (`datafeed.ts`) ya está
listo. Cuando te den acceso a `github.com/tradingview/charting_library`, sigue estos
pasos. Nada de esto toca el chart actual (`KaiChart.tsx` con klinecharts) hasta el
paso final, así que se puede preparar sin romper nada.

## 1. Copiar la librería

Acepta la invitación de GitHub, clona el repo y copia la carpeta de la librería a
`public/` de esta app:

```bash
# desde la raíz de kai-execution-ui
cp -r /ruta/al/charting_library/charting_library public/charting_library
```

Quedará servida en `/charting_library/charting_library.standalone.js`.

(Opcional, recomendado) instala los tipos para tener autocompletado:

```bash
pnpm add -D @types/tradingview__charting_library   # o copia el index.d.ts del repo
```

## 2. Cargar el script

En `index.html` (o vía un `<script>` dinámico en el componente), antes de montar:

```html
<script src="/charting_library/charting_library.standalone.js"></script>
```

## 3. Componente React (pegar como `src/components/TradingViewChart.tsx`)

```tsx
import { useEffect, useRef } from "react";
import { createMt5Datafeed } from "@/lib/tradingview/datafeed";
import { useMarketSocket } from "@/contexts/MarketSocketContext";

// `widget` viene del script global cargado en el paso 2.
declare global {
  interface Window {
    TradingView: { widget: new (opts: Record<string, unknown>) => { remove: () => void } };
  }
}

export function TradingViewChart({
  symbol,
  accountId,
  timeframe = "60", // resolución TradingView: "1","5","60","1D"…
}: {
  symbol: string;
  accountId: string;
  timeframe?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { socket, subscribe, unsubscribe } = useMarketSocket();

  useEffect(() => {
    if (!ref.current || !symbol || !accountId || !window.TradingView) return;
    const datafeed = createMt5Datafeed({ accountId, socket, subscribe, unsubscribe });
    const tvWidget = new window.TradingView.widget({
      container: ref.current,
      datafeed,
      symbol,
      interval: timeframe,
      library_path: "/charting_library/",
      autosize: true,
      theme: "dark",
      timezone: "Etc/UTC",
      locale: "es",
      // Mismos colores de Kai:
      overrides: {
        "mainSeriesProperties.candleStyle.upColor": "#2ed68d",
        "mainSeriesProperties.candleStyle.downColor": "#ef5350",
        "mainSeriesProperties.candleStyle.borderUpColor": "#2ed68d",
        "mainSeriesProperties.candleStyle.borderDownColor": "#ef5350",
        "mainSeriesProperties.candleStyle.wickUpColor": "#2ed68d",
        "mainSeriesProperties.candleStyle.wickDownColor": "#ef5350",
        "paneProperties.background": "#0a0e16",
        "paneProperties.backgroundType": "solid",
      },
      disabled_features: ["header_symbol_search", "symbol_search_hot_key"],
      enabled_features: ["hide_left_toolbar_by_default"],
    });
    return () => tvWidget.remove();
  }, [symbol, accountId, timeframe, socket, subscribe, unsubscribe]);

  return <div ref={ref} className="h-full w-full" />;
}
```

## 4. Reemplazar el chart en `TradingTerminal.tsx`

Cambia `<KaiChart … />` por `<TradingViewChart symbol={selectedSymbol} accountId={dbAccountId} timeframe={tvRes} />`.
Mapea el `timeframe` actual (`"1m","1h"…`) a la resolución de TradingView (`"1","60"…`):

```ts
const UI_TF_TO_TV: Record<string, string> = {
  "1m": "1", "5m": "5", "10m": "10", "15m": "15", "30m": "30",
  "1h": "60", "2h": "120", "4h": "240", D: "1D", W: "1W", M: "1M",
};
```

Las posiciones (líneas TP/SL/entry) se reimplementan con la API de shapes de
TradingView (`tvWidget.activeChart().createOrderLine()` / `createShape()`), que es
justo lo que hace Exness. Eso lo hago en la integración.

## Cómo funciona el Datafeed (`datafeed.ts`)

- **Historia** → `fetchCandles(accountId, symbol, mt5tf, count)` (nuestro `/rates`,
  ya soporta todas las temporalidades). Filtra al rango `[from, to]` que pide TV.
- **Realtime** → escucha el evento `tick` del market socket y agrega cada tick en
  la vela en formación de la resolución activa (open/high/low/close).
- Las resoluciones TV ↔ MT5 ya están mapeadas (`RES_TO_MT5`).

### Pendiente de afinar en la integración real (cuando haya librería para probar)
- **Paginación profunda de historia**: hoy el backend es por `count`. Para scroll
  infinito muy atrás conviene un endpoint por rango (el bridge ya tiene
  `/mt5/rates-range`); exponerlo en el backend y usarlo en `getBars` cuando
  `firstDataRequest === false`.
- **Sesiones de mercado** por símbolo (forex no es 24x7); hoy se usa `24x7` para
  no ocultar velas.
- **Alineación de la vela diaria/semanal** en realtime usa hora local; afinar a UTC
  del broker si se nota desfase en el cierre de vela.
