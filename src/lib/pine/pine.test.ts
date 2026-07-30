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

  it("input.* compila usando su valor por defecto", () => {
    const res = compilePine('len = input.int(9, "L")\nplot(ta.ema(close, len))');
    expect(res.ok).toBe(true);
  });

  it("lee título y overlay de indicator()", () => {
    const c = compileOk('indicator("Mi indi", overlay=false)\nplot(close)');
    expect(c.title).toBe("Mi indi");
    expect(c.overlay).toBe(false);
  });

  it("título desde argumento nombrado title= (nombre del indicador)", () => {
    const c = compileOk('indicator(title="Sniper CRT v2", overlay=true)\nplot(close)');
    expect(c.title).toBe("Sniper CRT v2");
    expect(c.overlay).toBe(true);
  });

  it("shorttitle= sirve de título si no hay title=", () => {
    const c = compileOk('indicator(shorttitle="SC2", overlay=true)\nplot(close)');
    expect(c.title).toBe("SC2");
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

describe("desestructuración de tupla ([a, b, c] = ta.macd/bb/dmi)", () => {
  it("una línea que empieza con '[' compila (regresión: 'Token inesperado [')", () => {
    const res = compilePine("[macdLine, signalLine, histLine] = ta.macd(close, 12, 26, 9)\nplot(macdLine)");
    expect(res.ok).toBe(true);
  });

  it("ta.macd: macdLine = ema(fast) - ema(slow)", () => {
    const c = compileOk(
      "[macdLine, signalLine, histLine] = ta.macd(close, 2, 4, 3)\n" +
        "ref = ta.ema(close, 2) - ta.ema(close, 4)\n" +
        "plot(macdLine)\nplot(ref)\nplot(histLine)",
    );
    const rows = c.calc(bars([1, 2, 3, 4, 5, 6, 7, 8]));
    const last = rows[rows.length - 1];
    expect(last.p0).not.toBeNull();
    expect(last.p0).toBeCloseTo(last.p1!, 9); // macdLine == ema2-ema4
    // hist = macdLine - signal; con señal ya sembrada, es finito
    expect(last.p2).not.toBeNull();
  });

  it("ta.bb: middle = sma y bandas simétricas a mult*stdev", () => {
    const c = compileOk(
      "[mid, upper, lower] = ta.bb(close, 3, 2)\n" +
        "m = ta.sma(close, 3)\nd = ta.stdev(close, 3)\n" +
        "plot(mid)\nplot(upper)\nplot(lower)\nplot(m)\nplot(d)",
    );
    const rows = c.calc(bars([2, 4, 6, 8, 10]));
    const r = rows[4];
    expect(r.p0).toBeCloseTo(r.p3!, 9); // mid == sma
    expect(r.p1! - r.p0!).toBeCloseTo(2 * r.p4!, 9); // upper - mid == 2*stdev
    expect(r.p0! - r.p2!).toBeCloseTo(2 * r.p4!, 9); // mid - lower == 2*stdev
  });

  it("ta.dmi: +DI/-DI/ADX finitos y en [0,100] con serie con tendencia", () => {
    const c = compileOk("[diPlus, diMinus, adx] = ta.dmi(3, 3)\nplot(diPlus)\nplot(diMinus)\nplot(adx)");
    const up: PineBar[] = Array.from({ length: 20 }, (_, k) => ({
      open: 10 + k,
      high: 11 + k,
      low: 9 + k,
      close: 10 + k,
      volume: 1,
    }));
    const rows = c.calc(up);
    const last = rows[rows.length - 1];
    for (const v of [last.p0, last.p1, last.p2]) {
      expect(v).not.toBeNull();
      expect(v!).toBeGreaterThanOrEqual(0);
      expect(v!).toBeLessThanOrEqual(100);
    }
    expect(last.p0!).toBeGreaterThan(last.p1!); // alcista sostenido: +DI domina a -DI
  });

  it("nombres desestructurados son usables después (reasignación / expresión)", () => {
    const c = compileOk("[macdLine, signalLine, histLine] = ta.macd(close, 2, 4, 3)\ncross = macdLine - signalLine\nplot(cross)");
    const rows = c.calc(bars([1, 2, 3, 4, 5, 6]));
    expect(rows[rows.length - 1].p0).not.toBeNull();
  });

  it("rechaza nº de nombres distinto al de retornos", () => {
    const res = compilePine("[a, b] = ta.macd(close, 12, 26, 9)\nplot(a)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("devuelve 3");
  });

  it("rechaza aridad de argumentos incorrecta", () => {
    const res = compilePine("[a, b, c] = ta.macd(close, 12, 26)\nplot(a)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("espera 4");
  });

  it("rechaza RHS que no es una función multi-retorno soportada", () => {
    const res = compilePine("[a, b, c] = ta.sma(close, 3)\nplot(a)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("multi-retorno");
  });

  it("ta.macd como escalar sigue siendo error (no está en TA_FUNCTIONS)", () => {
    const res = compilePine("x = ta.macd(close, 12, 26, 9)\nplot(x)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("ta.macd");
  });

  it("rechaza desestructurar sobre una serie integrada", () => {
    const res = compilePine("[close, b, c] = ta.macd(close, 12, 26, 9)\nplot(b)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("close");
  });
});

describe("estrategias", () => {
  it("parsea strategy() con if indentado y strategy.entry", () => {
    const c = compileOk(
      'strategy("S", overlay=true, initial_capital=5000)\n' +
        "fast = ta.ema(close, 2)\n" +
        "slow = ta.ema(close, 4)\n" +
        "if ta.crossover(fast, slow)\n" +
        '    strategy.entry("L", strategy.long)\n' +
        "if ta.crossunder(fast, slow)\n" +
        '    strategy.entry("S", strategy.short)\n' +
        "plot(fast)\n",
    );
    expect(c.isStrategy).toBe(true);
  });

  it("cruce genera trades y el reverse cierra el anterior", () => {
    const c = compileOk(
      'strategy("S")\n' +
        "m = ta.sma(close, 2)\n" +
        "if ta.crossover(close, m)\n" +
        '    strategy.entry("L", strategy.long)\n' +
        "if ta.crossunder(close, m)\n" +
        '    strategy.entry("S", strategy.short)\n' +
        "plot(m)\n",
    );
    // sube, baja, sube → al menos un trade cerrado por reversa
    const report = c.runStrategy(bars([10, 11, 14, 12, 9, 8, 12, 15]))!;
    expect(report.trades.length).toBeGreaterThanOrEqual(1);
    const reversed = report.trades.filter((t) => t.exitReason === "signal");
    expect(reversed.length).toBeGreaterThanOrEqual(1);
    // equity coherente: capital inicial + net (sin abierta) ≈ última equity
    const last = report.equity[report.equity.length - 1];
    const expected = report.initialCapital + report.netProfit + (report.openPosition?.unrealized ?? 0);
    expect(last).toBeCloseTo(expected, 6);
  });

  it("strategy.exit con stop se ejecuta al tocar el nivel", () => {
    const data: PineBar[] = [
      { open: 100, high: 101, low: 99, close: 100, volume: 1 },
      { open: 100, high: 102, low: 100, close: 101, volume: 1 }, // entra long al cierre
      { open: 101, high: 101, low: 94, close: 95, volume: 1 }, // toca el stop 98
    ];
    const c = compileOk(
      'strategy("S")\n' +
        "if close > open\n" +
        '    strategy.entry("L", strategy.long)\n' +
        "if strategy.position_size > 0\n" +
        "    strategy.exit(stop=98)\n" +
        "plot(close)\n",
    );
    const report = c.runStrategy(data)!;
    expect(report.trades.length).toBe(1);
    expect(report.trades[0].exitReason).toBe("stop");
    expect(report.trades[0].exitPrice).toBe(98);
    expect(report.trades[0].pnl).toBeCloseTo(98 - 101);
  });

  it("input.int se evalúa a su default", () => {
    const c = compileOk('len = input.int(3, title="L")\nm = ta.sma(close, len)\nplot(m)');
    const rows = c.calc(bars([1, 2, 3, 4]));
    expect(rows[2].p0).toBeCloseTo(2);
  });

  it(":= reasigna dentro de un if", () => {
    const c = compileOk("x = 0\nif close > open\n    x := 5\nelse\n    x := -5\nplot(x)");
    const data: PineBar[] = [
      { open: 1, high: 3, low: 0, close: 2, volume: 1 },
      { open: 3, high: 4, low: 1, close: 2, volume: 1 },
    ];
    const rows = c.calc(data);
    expect(rows[0].p0).toBe(5);
    expect(rows[1].p0).toBe(-5);
  });

  it(":= sobre variable no definida da error claro", () => {
    const res = compilePine("if close > open\n    y := 1\nplot(close)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("no está definida");
  });

  it("runStrategy es null para indicadores", () => {
    const c = compileOk("plot(close)");
    expect(c.isStrategy).toBe(false);
    expect(c.runStrategy(bars([1, 2, 3]))).toBeNull();
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

describe("var / declaraciones con tipo / bucles", () => {
  it("var persiste entre barras (no se recalcula cada barra)", () => {
    // contador que sólo se inicializa una vez y se incrementa con :=
    const c = compileOk("var count = 0\ncount := count + 1\nplot(count)");
    const rows = c.calc(bars([10, 20, 30, 40]));
    expect(rows[0].p0).toBe(1);
    expect(rows[1].p0).toBe(2);
    expect(rows[2].p0).toBe(3);
    expect(rows[3].p0).toBe(4);
  });

  it("sin var, la asignación se recalcula cada barra (arranca de 0)", () => {
    const c = compileOk("count = 0\ncount := count + 1\nplot(count)");
    const rows = c.calc(bars([10, 20, 30]));
    expect(rows[0].p0).toBe(1);
    expect(rows[1].p0).toBe(1);
    expect(rows[2].p0).toBe(1);
  });

  it("var mantiene un máximo acumulado (running high)", () => {
    const c = compileOk(
      "var hi = close\n" + "if close > hi\n" + "    hi := close\n" + "plot(hi)",
    );
    const rows = c.calc(bars([5, 3, 8, 6, 10, 4]));
    expect(rows[0].p0).toBe(5);
    expect(rows[1].p0).toBe(5);
    expect(rows[2].p0).toBe(8);
    expect(rows[3].p0).toBe(8);
    expect(rows[4].p0).toBe(10);
    expect(rows[5].p0).toBe(10);
  });

  it("acepta declaraciones con tipo (float / int) y var con tipo", () => {
    const c = compileOk("float a = close * 2.0\nvar int n = 0\nn := n + 1\nplot(a + n)");
    const rows = c.calc(bars([1, 2, 3]));
    expect(rows[0].p0).toBeCloseTo(1 * 2 + 1);
    expect(rows[1].p0).toBeCloseTo(2 * 2 + 2);
    expect(rows[2].p0).toBeCloseTo(3 * 2 + 3);
  });

  it("for suma acumulando en una var dentro de la misma barra", () => {
    // sum = 0+1+2+3+4 = 10 en cada barra
    const c = compileOk("var total = 0.0\ntotal := 0.0\nfor i = 1 to 4\n    total := total + i\nplot(total)");
    const rows = c.calc(bars([1, 2, 3]));
    expect(rows[0].p0).toBe(10);
    expect(rows[1].p0).toBe(10);
    expect(rows[2].p0).toBe(10);
  });

  it("for con 'by' respeta el paso", () => {
    const c = compileOk("s = 0.0\nfor i = 0 to 10 by 5\n    s := s + i\nplot(s)");
    const rows = c.calc(bars([1, 2]));
    expect(rows[0].p0).toBe(0 + 5 + 10);
  });

  it("while acumula con guardia anti-infinito", () => {
    const c = compileOk("k = 0.0\nx = 0.0\nwhile k < 3\n    x := x + 2\n    k := k + 1\nplot(x)");
    const rows = c.calc(bars([1, 2]));
    expect(rows[0].p0).toBe(6);
  });

  it("':=' con 'var' o tipo delante es error claro", () => {
    const res = compilePine("var x := 5\nplot(x)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain(":=");
  });

  it("for sin cuerpo indentado se reporta con línea", () => {
    const res = compilePine("s = 0.0\nfor i = 0 to 3\nplot(s)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.line).toBe(2);
  });
});

describe("funciones de usuario", () => {
  it("función de una línea", () => {
    const c = compileOk("double(x) => x * 2\nplot(double(close))");
    const rows = c.calc(bars([3, 5, 7]));
    expect(rows[0].p0).toBe(6);
    expect(rows[1].p0).toBe(10);
    expect(rows[2].p0).toBe(14);
  });

  it("varios parámetros y expresión compuesta", () => {
    const c = compileOk("weighted(a, b) => a * 0.7 + b * 0.3\nplot(weighted(high, low))");
    const rows = c.calc(bars([10, 20]));
    // high=c+1, low=c-1
    expect(rows[0].p0).toBeCloseTo(11 * 0.7 + 9 * 0.3);
    expect(rows[1].p0).toBeCloseTo(21 * 0.7 + 19 * 0.3);
  });

  it("parámetro con valor por defecto", () => {
    const c = compileOk("bump(x, k = 5) => x + k\nplot(bump(close))");
    const rows = c.calc(bars([1, 2, 3]));
    expect(rows[0].p0).toBe(6);
    expect(rows[2].p0).toBe(8);
  });

  it("parámetros con tipo delante (float/bool) se aceptan", () => {
    const c = compileOk("pick(bool up, float a, float b) => up ? a : b\nplot(pick(close > open, high, low))");
    const rows = c.calc(bars([5, 6]));
    // close==open en bars() => close>open es false => devuelve low = c-1
    expect(rows[0].p0).toBe(4);
  });

  it("cuerpo multilínea con variables locales y retorno final", () => {
    const c = compileOk(
      "range(a, b) =>\n" +
        "    hi = math.max(a, b)\n" +
        "    lo = math.min(a, b)\n" +
        "    hi - lo\n" +
        "plot(range(high, low))",
    );
    const rows = c.calc(bars([10, 20]));
    // high-low = (c+1)-(c-1) = 2
    expect(rows[0].p0).toBe(2);
    expect(rows[1].p0).toBe(2);
  });

  it("cuerpo multilínea con bucle for local", () => {
    const c = compileOk(
      "sumTo(nn) =>\n" +
        "    acc = 0.0\n" +
        "    for i = 1 to nn\n" +
        "        acc := acc + i\n" +
        "    acc\n" +
        "plot(sumTo(4))",
    );
    const rows = c.calc(bars([1, 2]));
    expect(rows[0].p0).toBe(10); // 1+2+3+4
  });

  it("las locales NO se filtran al ámbito global", () => {
    const res = compilePine("f(x) =>\n    tmp = x + 1\n    tmp\nplot(tmp)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("tmp");
  });

  it("aridad incorrecta se reporta", () => {
    const res = compilePine("f(a, b) => a + b\nplot(f(close))");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("argumento");
  });

  it("llamada a función desconocida da mensaje claro", () => {
    const res = compilePine("plot(noExisteFn(close))");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("noExisteFn");
  });
});

describe("arrays", () => {
  it("new_float + push + size + get", () => {
    const c = compileOk(
      "a = array.new_float(0)\n" +
        "array.push(a, close)\n" +
        "array.push(a, close * 2)\n" +
        "plot(array.get(a, 1))\n" +
        "plot(array.size(a))",
    );
    const rows = c.calc(bars([10]));
    expect(rows[0].p0).toBe(20); // get(a,1) = close*2
    expect(rows[0].p1).toBe(2); // size
  });

  it("new_float(size, initial) inicializa relleno", () => {
    const c = compileOk("a = array.new_float(3, 7)\nplot(array.get(a, 2))\nplot(array.size(a))");
    const rows = c.calc(bars([1]));
    expect(rows[0].p0).toBe(7);
    expect(rows[0].p1).toBe(3);
  });

  it("shift devuelve el primero y encoge", () => {
    const c = compileOk(
      "a = array.new_float(0)\n" +
        "array.push(a, 100)\n" +
        "array.push(a, 200)\n" +
        "first = array.shift(a)\n" +
        "plot(first)\n" +
        "plot(array.size(a))",
    );
    const rows = c.calc(bars([1]));
    expect(rows[0].p0).toBe(100);
    expect(rows[0].p1).toBe(1);
  });

  it("var array acumula entre barras (cola FIFO)", () => {
    const c = compileOk(
      "var a = array.new_float(0)\n" +
        "array.push(a, close)\n" +
        "while array.size(a) > 3\n" +
        "    array.shift(a)\n" +
        "plot(array.size(a))\n" +
        "plot(array.first(a))",
    );
    const rows = c.calc(bars([10, 20, 30, 40, 50]));
    // Tamaño crece hasta 3 y se estabiliza (FIFO capado a 3).
    expect(rows[0].p0).toBe(1);
    expect(rows[2].p0).toBe(3);
    expect(rows[4].p0).toBe(3);
    // El más antiguo tras el capado en la barra 5: se metió 10,20,30,40,50 → quedan 30,40,50.
    expect(rows[4].p1).toBe(30);
  });

  it("set y remove modifican in-place", () => {
    const c = compileOk(
      "a = array.new_float(0)\n" +
        "array.push(a, 1)\n" +
        "array.push(a, 2)\n" +
        "array.push(a, 3)\n" +
        "array.set(a, 1, 99)\n" +
        "removed = array.remove(a, 0)\n" +
        "plot(removed)\n" +
        "plot(array.get(a, 0))\n" +
        "plot(array.size(a))",
    );
    const rows = c.calc(bars([1]));
    expect(rows[0].p0).toBe(1); // removed
    expect(rows[0].p1).toBe(99); // set(1,99) ahora en índice 0 tras remove
    expect(rows[0].p2).toBe(2); // size
  });

  it("declaración con tipo array 'var float[]' parsea", () => {
    const c = compileOk("var float[] xs = array.new_float(0)\narray.push(xs, close)\nplot(array.size(xs))");
    const rows = c.calc(bars([5, 6]));
    expect(rows[0].p0).toBe(1);
    expect(rows[1].p0).toBe(2);
  });

  it("array.desconocida da error claro", () => {
    const res = compilePine("a = array.new_float(0)\nplot(array.noexiste(a))");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain("noexiste");
  });
});

describe("builtins (bar_index, na, nz, time, timeframe, inputs)", () => {
  it("bar_index devuelve el índice de la barra", () => {
    const c = compileOk("plot(bar_index)");
    const rows = c.calc(bars([10, 11, 12]));
    expect(rows[0].p0).toBe(0);
    expect(rows[1].p0).toBe(1);
    expect(rows[2].p0).toBe(2);
  });

  it("na() detecta na y nz() lo sustituye", () => {
    const c = compileOk("x = close > 100 ? close : na\nplot(na(x) ? 1 : 0)\nplot(nz(x, -1))");
    const rows = c.calc(bars([50, 150]));
    expect(rows[0].p0).toBe(1); // na
    expect(rows[0].p1).toBe(-1); // nz reemplaza
    expect(rows[1].p0).toBe(0); // no na
    expect(rows[1].p1).toBe(150);
  });

  it("timeframe.isintraday con barras de 1 minuto", () => {
    const c = compileOk("plot(timeframe.isintraday ? 1 : 0)");
    const withTime: PineBar[] = [0, 1, 2].map((k) => ({
      open: 10, high: 11, low: 9, close: 10, volume: 1, time: k * 60000,
    }));
    const rows = c.calc(withTime);
    expect(rows[0].p0).toBe(1);
  });

  it("time(period, session, tz) filtra por sesión", () => {
    const c = compileOk('plot(na(time(timeframe.period, "1800-0929", "UTC+0")) ? 0 : 1)');
    // Barra a las 19:00 UTC (dentro) y a las 12:00 UTC (fuera).
    const h = (hour: number) => Date.UTC(2024, 0, 2, hour, 0, 0);
    const data: PineBar[] = [
      { open: 1, high: 1, low: 1, close: 1, volume: 1, time: h(19) },
      { open: 1, high: 1, low: 1, close: 1, volume: 1, time: h(12) },
    ];
    const rows = c.calc(data);
    expect(rows[0].p0).toBe(1); // 19:00 en sesión 1800-0929
    expect(rows[1].p0).toBe(0); // 12:00 fuera
  });

  it("input.session/string/color se resuelven a su defecto (compila)", () => {
    const c = compileOk(
      'sess = input.session("1800-0929", title="S")\n' +
        'zone = input.string("UTC-4", title="Z")\n' +
        "col = input.color(color.new(color.green, 78), title=\"C\")\n" +
        "plot(close)",
    );
    expect(c.figures.length).toBe(1);
  });

  it("color.new(base, transp) produce rgba con alpha", () => {
    const c = compileOk("plot(close, color=color.new(color.green, 78))");
    // transp 78 → alpha ~0.22
    expect(c.figures[0].color.startsWith("rgba(")).toBe(true);
    expect(c.figures[0].color).toContain("0.220");
  });

  it("bloque if/else con sesiones acumula high de la sesión", () => {
    const c = compileOk(
      'inSess = not na(time(timeframe.period, "0000-2359", "UTC+0"))\n' +
        "var float sHigh = na\n" +
        "if inSess\n" +
        "    sHigh := na(sHigh) ? high : math.max(sHigh, high)\n" +
        "plot(sHigh)",
    );
    const data: PineBar[] = [10, 30, 20].map((c2, k) => ({
      open: c2, high: c2, low: c2, close: c2, volume: 1, time: k * 60000,
    }));
    const rows = c.calc(data);
    expect(rows[0].p0).toBe(10);
    expect(rows[1].p0).toBe(30);
    expect(rows[2].p0).toBe(30); // máximo se mantiene
  });
});

describe("dibujos (box / line)", () => {
  it("box.new crea una caja con coords y color", () => {
    const c = compileOk(
      "b = box.new(bar_index, high, bar_index + 5, low, bgcolor=color.new(color.green, 80), border_width=2)\n" +
        "plot(close)",
    );
    const d = c.drawings(bars([10, 20]));
    expect(d.boxes.length).toBe(2); // una por barra (sin var)
    const b = d.boxes[d.boxes.length - 1];
    expect(b.left).toBe(1);
    expect(b.right).toBe(6);
    expect(b.borderWidth).toBe(2);
    expect(b.bgColor.startsWith("rgba(")).toBe(true);
  });

  it("var box + set_* + delete: una sola caja viva, mutada entre barras", () => {
    const c = compileOk(
      "var box bx = na\n" +
        "if bar_index == 0\n" +
        "    bx := box.new(left=bar_index, top=high, right=bar_index, bottom=low)\n" +
        "if not na(bx)\n" +
        "    box.set_right(bx, bar_index)\n" +
        "    box.set_top(bx, high)\n" +
        "plot(close)",
    );
    const d = c.drawings(bars([10, 20, 30]));
    expect(d.boxes.length).toBe(1); // var → una sola, persiste
    expect(d.boxes[0].left).toBe(0);
    expect(d.boxes[0].right).toBe(2); // set_right en la última barra
    expect(d.boxes[0].top).toBe(31); // high de la barra 3 = 30+1
  });

  it("box.delete la quita del render", () => {
    const c = compileOk(
      "b = box.new(bar_index, high, bar_index, low)\n" +
        "box.delete(b)\n" +
        "plot(close)",
    );
    const d = c.drawings(bars([10]));
    expect(d.boxes.length).toBe(0);
  });

  it("line.new con estilo y cola FIFO en array", () => {
    const c = compileOk(
      "var line[] xs = array.new_line()\n" +
        "array.push(xs, line.new(bar_index, close, bar_index + 3, close, color=color.blue, width=2, style=line.style_dashed))\n" +
        "while array.size(xs) > 2\n" +
        "    line.delete(array.shift(xs))\n" +
        "plot(close)",
    );
    const d = c.drawings(bars([10, 11, 12, 13, 14]));
    expect(d.lines.length).toBe(2); // FIFO capado a 2 vivas
    expect(d.lines[0].style).toBe("dashed");
    expect(d.lines[0].width).toBe(2);
  });

  it("hasDrawings distingue scripts con y sin dibujos", () => {
    const withD = compileOk("box.new(bar_index, high, bar_index, low)\nplot(close)");
    const noD = compileOk("plot(close)");
    expect(withD.hasDrawings).toBe(true);
    expect(noD.hasDrawings).toBe(false);
  });

  it("box.new partido en varias líneas físicas (continuación por paréntesis abierto)", () => {
    const c = compileOk(
      "b = box.new(left=bar_index, top=high, right=bar_index + 1,\n" +
        "     bottom=low, border_width=1,\n" +
        "     bgcolor=color.new(color.blue, 85))\n" +
        "plot(close)",
    );
    const d = c.drawings(bars([10, 11, 12]));
    expect(d.boxes.length).toBe(3);
    expect(d.boxes[0].top).toBe(11); // high de la primera vela = close+1
  });

  it("label.new pinta etiqueta con texto, estilo y color", () => {
    const c = compileOk(
      'l = label.new(bar_index, high, text="BUY", style=label.style_label_up, color=color.green, textcolor=color.white, size=size.small)\n' +
        "plot(close)",
    );
    const d = c.drawings(bars([10, 11, 12]));
    expect(d.labels.length).toBe(3);
    expect(d.labels[0].text).toBe("BUY");
    expect(d.labels[0].style).toBe("label_up");
    expect(d.labels[0].size).toBe("small");
    expect(d.labels[0].y).toBe(11);
  });

  it("label.set_text / label.delete mutan y borran", () => {
    const c = compileOk(
      "l = label.new(bar_index, close, text=\"x\")\n" +
        'label.set_text(l, "y")\n' +
        "if close > 11\n" +
        "    label.delete(l)\n" +
        "plot(close)",
    );
    const d = c.drawings(bars([10, 11, 12, 13]));
    // 2 velas con close<=11 sobreviven, texto actualizado a "y"
    expect(d.labels.length).toBe(2);
    expect(d.labels.every((x) => x.text === "y")).toBe(true);
  });

  it("table.new + table.cell construyen panel con celdas", () => {
    const c = compileOk(
      "var t = table.new(position.top_right, 2, 1, border_width=1)\n" +
        "if barstate.islast\n" +
        '    table.cell(t, 0, 0, "WIN", text_color=color.white, text_size=size.small)\n' +
        '    table.cell(t, 1, 0, "42", text_color=color.green, text_size=size.normal)\n' +
        "plot(close)",
    );
    const d = c.drawings(bars([10, 11, 12]));
    expect(d.tables.length).toBe(1);
    expect(d.tables[0].position).toBe("top_right");
    expect(d.tables[0].columns).toBe(2);
    expect(d.tables[0].borderWidth).toBe(1);
    expect(d.tables[0].cells.length).toBe(2);
    expect(d.tables[0].cells[1].text).toBe("42");
    expect(d.tables[0].cells[1].textColor).toBe("#2ed68d"); // color.green del engine
  });

  it("str.tostring de un contador NO colisiona con handles de string", () => {
    // Se internan varios strings (label.text) para ocupar handles bajos; luego
    // str.tostring(contador) debe dar el número, no un string interno.
    const c = compileOk(
      "var t = table.new(position.top_right, 1, 1)\n" +
        'l = label.new(bar_index, close, text="AAA")\n' +
        "cnt = close > 11 ? 2 : 1\n" +
        "if barstate.islast\n" +
        '    table.cell(t, 0, 0, str.tostring(cnt))\n' +
        "plot(close)",
    );
    const d = c.drawings(bars([10, 11, 12]));
    expect(d.tables[0].cells[0].text).toBe("2"); // close=12>11 en la última vela
  });

  it("str.tostring con formato y concatenación con %", () => {
    const c = compileOk(
      "var t = table.new(position.top_right, 1, 1)\n" +
        "wr = close > 11 ? 66.6666 : 0.0\n" +
        "if barstate.islast\n" +
        '    table.cell(t, 0, 0, str.tostring(wr, "#.#") + "%")\n' +
        "plot(close)",
    );
    const d = c.drawings(bars([10, 11, 12]));
    expect(d.tables[0].cells[0].text).toBe("66.7%"); // 1 decimal + sufijo
  });

  it("math.avg / sign / exp calculan", () => {
    const c = compileOk(
      "a = math.avg(2, 4, 6)\n" +
        "s = math.sign(close - 11)\n" +
        "plot(a)\n" +
        "plot(s)",
    );
    const rows = c.calc(bars([10, 11, 12]));
    expect(rows[0].p0).toBe(4); // avg(2,4,6)
    expect(rows[0].p1).toBe(-1); // sign(10-11)
    expect(rows[2].p1).toBe(1); // sign(12-11)
  });
});

describe("literales de array en options= (regresión: 'Token inesperado [')", () => {
  it("input.string con options=[…] compila", () => {
    const res = compilePine(
      'modo = input.string("Invertir", title="Que hacer", options=["Invertir","Descartar"], group="g")\n' +
        "plot(close)",
    );
    expect(res.ok).toBe(true);
  });

  it("options= multilínea con más de dos opciones compila", () => {
    const res = compilePine(
      'm = input.string("Choppiness Index", title="Metodo",\n' +
        '     options=["Choppiness Index","Squeeze Momentum","Recorrido / ATR","Combinado (2 de 3)"], group="g",\n' +
        '     tooltip="tres formas de medirlo")\n' +
        "plot(close)",
    );
    expect(res.ok).toBe(true);
  });

  it("el input toma su valor por defecto y las options se descartan", () => {
    const c = compileOk('n = input.string("a", options=["a","b"])\nplot(close)');
    expect(c.calc(bars([1, 2, 3])).length).toBe(3);
  });

  it("un literal de array usado como valor da error claro", () => {
    const res = compilePine("x = [1, 2, 3]\nplot(x)");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/literal de array/i);
  });
});
