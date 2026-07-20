// Plantillas de arranque del editor Kai Pine (menú "Nuevo").

export interface PineExample {
  name: string;
  source: string;
}

export const PINE_EXAMPLES: PineExample[] = [
  {
    name: "Cruce de EMAs",
    source: `indicator("Cruce de EMAs", overlay=true)
fast = ta.ema(close, 9)
slow = ta.ema(close, 21)
plot(fast, color=color.green, title="EMA 9")
plot(slow, color=color.red, title="EMA 21")
`,
  },
  {
    name: "RSI clásico",
    source: `indicator("RSI 14", overlay=false)
r = ta.rsi(close, 14)
plot(r, color=color.purple, title="RSI")
hline(70, color=color.gray, title="Sobrecompra")
hline(30, color=color.gray, title="Sobreventa")
`,
  },
  {
    name: "Canal de máximos/mínimos",
    source: `indicator("Canal 20", overlay=true)
techo = ta.highest(high, 20)
piso = ta.lowest(low, 20)
plot(techo, color=color.aqua, title="Techo 20")
plot(piso, color=color.orange, title="Piso 20")
`,
  },
  {
    name: "ATR (volatilidad)",
    source: `indicator("ATR 14", overlay=false)
a = ta.atr(14)
plot(a, color=color.yellow, title="ATR")
`,
  },
  {
    name: "Momentum simple",
    source: `indicator("Momentum", overlay=false)
mom = close - close[10]
plot(mom, color=color.blue, title="Cierre vs hace 10 velas")
hline(0, color=color.gray)
`,
  },
];

export const DEFAULT_SOURCE = PINE_EXAMPLES[0].source;
