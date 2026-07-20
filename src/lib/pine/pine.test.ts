import { describe, expect, it } from "vitest";
import { compilePine } from "./compilePine";
import { PineBar } from "./pineRuntime";
import { PINE_EXAMPLES } from "./examples";

function bars(closes: number[]): PineBar[] {
  return closes.map((c) => ({ open: c, high: c + 1, low: c - 1, close: c, volume: 100 }));
}

function compileOk(source: string) {
  const res = compilePine(source);
  if (!res.ok) throw new Error(`compile falló: L${res.error.line}: ${res.error.message}`);
  return res.compiled;
}

describe("parser", () => {
  it("reporta línea en errores de sintaxis", () => {
    const res = compilePine('indicator("x")\nfoo === bar\nplot(close)');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.line).toBe(2);
  });

  it("rechaza variables no definidas", () => {
    const res = compilePine("plot(noExiste)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("noExiste");
  });

  it("rechaza funciones desconocidas con mensaje claro", () => {
    const res = compilePine("x = ta.superma(close, 5)\nplot(x)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("ta.superma");
  });

  it("exige al menos un plot/hline", () => {
    const res = compilePine("x = ta.ema(close, 5)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("plot");
  });

  it("input.* explica que llega en fase 2", () => {
    const res = compilePine('len = input.int(9, "L")\nplot(ta.ema(close, 9))');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("fase 2");
  });

  it("lee título y overlay de indicator()", () => {
    const c = compileOk('indicator("Mi indi", overlay=false)\nplot(close)');
    expect(c.title).toBe("Mi indi");
    expect(c.overlay).toBe(false);
  });

  it("overlay default true y color con nombre", () => {
    const c = compileOk("plot(close, color=color.green)");
    expect(c.overlay).toBe(true);
    expect(c.figures[0].color).toBe("#2ed68d");
  });
});

describe("expresiones", () => {
  it("precedencia aritmética y ternario", () => {
    const c = compileOk("x = 1 + 2 * 3\ny = x > 6 ? 100 : 200\nplot(x)\nplot(y)");
    const rows = c.calc(bars([10]));
    expect(rows[0].p0).toBe(7);
    expect(rows[0].p1).toBe(100);
  });

  it("historia con corchetes sobre builtin y variable", () => {
    const c = compileOk("prev = close[1]\ndelta = close - prev\nplot(delta)");
    const rows = c.calc(bars([10, 12, 15]));
    expect(rows[0].p0).toBeNull(); // sin barra previa → na → null
    expect(rows[1].p0).toBe(2);
    expect(rows[2].p0).toBe(3);
  });

  it("and/or/not y comparaciones", () => {
    const c = compileOk("up = close > open ? 1 : 0\nsig = up == 1 and volume > 0 ? 5 : -5\nplot(sig)");
    const data: PineBar[] = [
      { open: 1, high: 3, low: 0, close: 2, volume: 10 },
      { open: 3, high: 4, low: 1, close: 2, volume: 10 },
    ];
    const rows = c.calc(data);
    expect(rows[0].p0).toBe(5);
    expect(rows[1].p0).toBe(-5);
  });

  it("división por cero → hueco (null), no Infinity", () => {
    const c = compileOk("x = close / (close - close)\nplot(x)");
    const rows = c.calc(bars([5]));
    expect(rows[0].p0).toBeNull();
  });
});

describe("ta.*", () => {
  it("sma con valores conocidos", () => {
    const c = compileOk("m = ta.sma(close, 3)\nplot(m)");
    const rows = c.calc(bars([1, 2, 3, 4, 5]));
    expect(rows[0].p0).toBeNull();
    expect(rows[1].p0).toBeNull();
    expect(rows[2].p0).toBeCloseTo(2);
    expect(rows[3].p0).toBeCloseTo(3);
    expect(rows[4].p0).toBeCloseTo(4);
  });

  it("ema siembra con SMA y luego suaviza", () => {
    const c = compileOk("m = ta.ema(close, 3)\nplot(m)");
    const rows = c.calc(bars([2, 4, 6, 8]));
    expect(rows[1].p0).toBeNull();
    expect(rows[2].p0).toBeCloseTo(4); // SMA(2,4,6)
    // alpha=0.5 → 8*0.5 + 4*0.5 = 6
    expect(rows[3].p0).toBeCloseTo(6);
  });

  it("highest/lowest sobre ventana", () => {
    const c = compileOk("h = ta.highest(close, 2)\nl = ta.lowest(close, 2)\nplot(h)\nplot(l)");
    const rows = c.calc(bars([3, 1, 4, 1, 5]));
    expect(rows[2].p0).toBe(4);
    expect(rows[2].p1).toBe(1);
    expect(rows[4].p0).toBe(5);
    expect(rows[4].p1).toBe(1);
  });

  it("dos call-sites de ta.ema no comparten estado", () => {
    const c = compileOk("a = ta.ema(close, 2)\nb = ta.ema(close, 4)\nplot(a)\nplot(b)");
    const rows = c.calc(bars([1, 2, 3, 4, 5, 6]));
    // len distinto → series distintas
    expect(rows[5].p0).not.toBeNull();
    expect(rows[5].p1).not.toBeNull();
    expect(rows[5].p0).not.toBe(rows[5].p1);
  });

  it("crossover dispara solo en el cruce", () => {
    const c = compileOk("x = ta.crossover(close, ta.sma(close, 2)) ? 1 : 0\nplot(x)");
    const rows = c.calc(bars([10, 8, 6, 9, 12]));
    const fired = rows.map((r) => r.p0);
    // el cruce alcista ocurre cuando close pasa de <=sma a >sma
    expect(fired.filter((v) => v === 1).length).toBeGreaterThanOrEqual(1);
    expect(fired[1]).toBe(0); // bajando, no hay cruce alcista
  });

  it("rsi queda entre 0 y 100 y sube con serie alcista", () => {
    const c = compileOk("r = ta.rsi(close, 3)\nplot(r)");
    const rows = c.calc(bars([1, 2, 3, 4, 5, 6, 7]));
    const last = rows[6].p0!;
    expect(last).toBeGreaterThan(50);
    expect(last).toBeLessThanOrEqual(100);
  });

  it("atr con velas planas es el rango high-low", () => {
    const c = compileOk("a = ta.atr(2)\nplot(a)");
    const flat: PineBar[] = Array.from({ length: 5 }, () => ({ open: 10, high: 11, low: 9, close: 10, volume: 1 }));
    const rows = c.calc(flat);
    expect(rows[4].p0).toBeCloseTo(2);
  });

  it("length inválido se reporta al compilar (smoke-run), no al aplicar", () => {
    const res = compilePine("m = ta.sma(close, 0)\nplot(m)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("length");
  });
});

describe("salidas", () => {
  it("hline produce nivel constante y figura isLevel", () => {
    const c = compileOk('indicator("x", overlay=false)\nr = ta.rsi(close, 2)\nplot(r)\nhline(70, title="OB")');
    expect(c.figures[1].isLevel).toBe(true);
    const rows = c.calc(bars([1, 2, 3]));
    expect(rows[0].p1).toBe(70);
    expect(rows[2].p1).toBe(70);
  });

  it("los ejemplos de plantilla compilan todos", () => {
    for (const ex of PINE_EXAMPLES) {
      const res = compilePine(ex.source);
      expect(res.ok, `plantilla '${ex.name}'`).toBe(true);
    }
  });

  it("linewidth se acota a 1..4", () => {
    const c = compileOk("plot(close, linewidth=9)");
    expect(c.figures[0].linewidth).toBe(4);
  });
});
