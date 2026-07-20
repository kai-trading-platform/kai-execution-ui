// Runtime del subset Pine de Kai: evalúa el programa BARRA A BARRA respetando
// la semántica de series de TradingView — cada call-site ta.* (identificado por
// siteId del AST) mantiene su PROPIO estado (EMA previa, ventana rodante, prevs
// de crossover), de modo que dos ta.ema(close, 9) en líneas distintas no se
// contaminan entre sí. NaN modela `na`: se propaga en aritmética, compara a
// false y al final se convierte a null (lo que klinecharts espera como hueco).

import { Expr, Stmt, PineError, BUILTIN_SERIES } from "./pineParser";

export interface PineBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ── Estados por call-site ────────────────────────────────────────────────────

interface EmaState {
  len: number;
  sum: number;
  count: number;
  prev: number; // NaN hasta sembrar con SMA(len)
}

interface WindowState {
  values: number[]; // ventana rodante (más nuevo al final)
}

interface RsiState {
  len: number;
  prevSrc: number;
  avgGain: number;
  avgLoss: number;
  count: number;
}

interface PrevState {
  prevA: number;
  prevB: number;
}

interface ChangeState {
  prev: number;
}

type SiteState = EmaState | WindowState | RsiState | PrevState | ChangeState | Record<string, number>;

// ── Ejecutor ─────────────────────────────────────────────────────────────────

export interface RunResult {
  /** Una entrada por plot/hline (en orden de aparición): serie de valores. */
  series: Array<Array<number | null>>;
}

export function runPine(statements: Stmt[], bars: PineBar[]): RunResult {
  const n = bars.length;
  const varBuffers = new Map<string, Float64Array>();
  const siteStates = new Map<number, SiteState>();

  const outputs: Stmt[] = statements.filter((s) => s.kind === "plot" || s.kind === "hline");
  const series: Array<Array<number | null>> = outputs.map(() => new Array<number | null>(n).fill(null));

  const builtinAt = (name: string, i: number): number => {
    if (i < 0 || i >= n) return NaN;
    const b = bars[i];
    switch (name) {
      case "open":
        return b.open;
      case "high":
        return b.high;
      case "low":
        return b.low;
      case "close":
        return b.close;
      case "volume":
        return b.volume;
      case "hl2":
        return (b.high + b.low) / 2;
      case "hlc3":
        return (b.high + b.low + b.close) / 3;
      case "ohlc4":
        return (b.open + b.high + b.low + b.close) / 4;
      default:
        return NaN;
    }
  };

  const truthy = (v: number): boolean => !Number.isNaN(v) && v !== 0;

  function evalExpr(e: Expr, i: number): number {
    switch (e.kind) {
      case "num":
        return e.value;
      case "str":
        return NaN; // strings solo viven en args constantes ya extraídos
      case "ident": {
        if (e.name === "true") return 1;
        if (e.name === "false") return 0;
        if (e.name === "na") return NaN;
        if (BUILTIN_SERIES.has(e.name)) return builtinAt(e.name, i);
        const buf = varBuffers.get(e.name);
        return buf ? buf[i] : NaN;
      }
      case "member":
        return NaN; // colores se resuelven fuera del runtime numérico
      case "index": {
        const off = evalExpr(e.offset, i);
        if (Number.isNaN(off) || off < 0) return NaN;
        const j = i - Math.floor(off);
        if (j < 0) return NaN;
        const base = e.base;
        if (base.kind === "ident") {
          if (BUILTIN_SERIES.has(base.name)) return builtinAt(base.name, j);
          const buf = varBuffers.get(base.name);
          return buf ? buf[j] : NaN;
        }
        throw new PineError("El operador [n] solo aplica a series (variables o open/close/…)", e.line);
      }
      case "unary": {
        const v = evalExpr(e.expr, i);
        if (e.op === "-") return -v;
        return truthy(v) ? 0 : 1; // not
      }
      case "bin": {
        if (e.op === "and") {
          return truthy(evalExpr(e.left, i)) && truthy(evalExpr(e.right, i)) ? 1 : 0;
        }
        if (e.op === "or") {
          return truthy(evalExpr(e.left, i)) || truthy(evalExpr(e.right, i)) ? 1 : 0;
        }
        const a = evalExpr(e.left, i);
        const b = evalExpr(e.right, i);
        switch (e.op) {
          case "+":
            return a + b;
          case "-":
            return a - b;
          case "*":
            return a * b;
          case "/":
            return b === 0 ? NaN : a / b;
          case "%":
            return b === 0 ? NaN : a % b;
          case ">":
            return a > b ? 1 : 0;
          case "<":
            return a < b ? 1 : 0;
          case ">=":
            return a >= b ? 1 : 0;
          case "<=":
            return a <= b ? 1 : 0;
          case "==":
            return a === b ? 1 : 0;
          case "!=":
            return a !== b ? 1 : 0;
          default:
            return NaN;
        }
      }
      case "ternary":
        return truthy(evalExpr(e.cond, i)) ? evalExpr(e.then, i) : evalExpr(e.else, i);
      case "call":
        return evalCall(e, i);
    }
  }

  function constLen(e: Expr, line: number): number {
    const v = evalExpr(e, 0);
    if (!Number.isFinite(v) || v < 1) throw new PineError("El período (length) debe ser un número >= 1", line);
    return Math.floor(v);
  }

  function evalCall(e: Extract<Expr, { kind: "call" }>, i: number): number {
    if (e.ns === "math") {
      const args = e.args.map((a) => evalExpr(a, i));
      switch (e.name) {
        case "abs":
          return Math.abs(args[0]);
        case "max":
          return Math.max(...args);
        case "min":
          return Math.min(...args);
        case "round":
          return Math.round(args[0]);
        case "floor":
          return Math.floor(args[0]);
        case "ceil":
          return Math.ceil(args[0]);
        case "sqrt":
          return Math.sqrt(args[0]);
        case "pow":
          return Math.pow(args[0], args[1]);
        case "log":
          return Math.log(args[0]);
        default:
          return NaN;
      }
    }
    if (e.ns !== "ta") return NaN; // color.rgb etc. no son numéricas

    switch (e.name) {
      case "ema": {
        const src = evalExpr(e.args[0], i);
        const len = constLen(e.args[1], e.line);
        let st = siteStates.get(e.siteId) as EmaState | undefined;
        if (!st) {
          st = { len, sum: 0, count: 0, prev: NaN };
          siteStates.set(e.siteId, st);
        }
        if (Number.isNaN(src)) return st.prev;
        if (Number.isNaN(st.prev)) {
          // Siembra con SMA de los primeros `len` valores (na hasta entonces).
          st.sum += src;
          st.count++;
          if (st.count < st.len) return NaN;
          st.prev = st.sum / st.len;
          return st.prev;
        }
        const alpha = 2 / (st.len + 1);
        st.prev = src * alpha + st.prev * (1 - alpha);
        return st.prev;
      }
      case "sma":
      case "wma":
      case "stdev":
      case "highest":
      case "lowest": {
        const src = evalExpr(e.args[0], i);
        const len = constLen(e.args[1], e.line);
        let st = siteStates.get(e.siteId) as WindowState | undefined;
        if (!st) {
          st = { values: [] };
          siteStates.set(e.siteId, st);
        }
        st.values.push(src);
        if (st.values.length > len) st.values.shift();
        if (st.values.length < len || st.values.some(Number.isNaN)) return NaN;
        const w = st.values;
        switch (e.name) {
          case "sma":
            return w.reduce((s, v) => s + v, 0) / len;
          case "wma": {
            let num = 0;
            let den = 0;
            for (let k = 0; k < len; k++) {
              const weight = k + 1; // más peso al más reciente (último)
              num += w[k] * weight;
              den += weight;
            }
            return num / den;
          }
          case "stdev": {
            const mean = w.reduce((s, v) => s + v, 0) / len;
            const variance = w.reduce((s, v) => s + (v - mean) * (v - mean), 0) / len;
            return Math.sqrt(variance);
          }
          case "highest":
            return Math.max(...w);
          case "lowest":
            return Math.min(...w);
        }
        return NaN;
      }
      case "rsi": {
        const src = evalExpr(e.args[0], i);
        const len = constLen(e.args[1], e.line);
        let st = siteStates.get(e.siteId) as RsiState | undefined;
        if (!st) {
          st = { len, prevSrc: NaN, avgGain: 0, avgLoss: 0, count: 0 };
          siteStates.set(e.siteId, st);
        }
        if (Number.isNaN(src)) return NaN;
        if (Number.isNaN(st.prevSrc)) {
          st.prevSrc = src;
          return NaN;
        }
        const diff = src - st.prevSrc;
        st.prevSrc = src;
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        st.count++;
        if (st.count <= st.len) {
          // acumulación inicial (promedio simple de los primeros len cambios)
          st.avgGain += gain / st.len;
          st.avgLoss += loss / st.len;
          if (st.count < st.len) return NaN;
        } else {
          // suavizado de Wilder
          st.avgGain = (st.avgGain * (st.len - 1) + gain) / st.len;
          st.avgLoss = (st.avgLoss * (st.len - 1) + loss) / st.len;
        }
        if (st.avgLoss === 0) return 100;
        const rs = st.avgGain / st.avgLoss;
        return 100 - 100 / (1 + rs);
      }
      case "tr":
      case "atr": {
        const b = bars[i];
        const prevClose = i > 0 ? bars[i - 1].close : NaN;
        const tr = Number.isNaN(prevClose)
          ? b.high - b.low
          : Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
        if (e.name === "tr") return tr;
        const len = constLen(e.args[0], e.line);
        let st = siteStates.get(e.siteId) as EmaState | undefined;
        if (!st) {
          st = { len, sum: 0, count: 0, prev: NaN };
          siteStates.set(e.siteId, st);
        }
        if (Number.isNaN(st.prev)) {
          st.sum += tr;
          st.count++;
          if (st.count < st.len) return NaN;
          st.prev = st.sum / st.len;
          return st.prev;
        }
        // Wilder: RMA
        st.prev = (st.prev * (st.len - 1) + tr) / st.len;
        return st.prev;
      }
      case "change": {
        const src = evalExpr(e.args[0], i);
        let st = siteStates.get(e.siteId) as ChangeState | undefined;
        if (!st) {
          st = { prev: NaN };
          siteStates.set(e.siteId, st);
        }
        const out = src - st.prev;
        st.prev = src;
        return out;
      }
      case "crossover":
      case "crossunder": {
        const a = evalExpr(e.args[0], i);
        const b = evalExpr(e.args[1], i);
        let st = siteStates.get(e.siteId) as PrevState | undefined;
        if (!st) {
          st = { prevA: NaN, prevB: NaN };
          siteStates.set(e.siteId, st);
        }
        const { prevA, prevB } = st;
        st.prevA = a;
        st.prevB = b;
        if ([a, b, prevA, prevB].some(Number.isNaN)) return 0;
        if (e.name === "crossover") return prevA <= prevB && a > b ? 1 : 0;
        return prevA >= prevB && a < b ? 1 : 0;
      }
      default:
        return NaN;
    }
  }

  // Prepara buffers de variables (en orden de asignación)
  for (const s of statements) {
    if (s.kind === "assign" && !varBuffers.has(s.name)) {
      const buf = new Float64Array(n);
      buf.fill(NaN);
      varBuffers.set(s.name, buf);
    }
  }

  for (let i = 0; i < n; i++) {
    let outIdx = 0;
    for (const s of statements) {
      if (s.kind === "assign") {
        varBuffers.get(s.name)![i] = evalExpr(s.expr, i);
      } else if (s.kind === "plot") {
        const v = evalExpr(s.expr, i);
        series[outIdx][i] = Number.isFinite(v) ? v : null;
        outIdx++;
      } else if (s.kind === "hline") {
        const v = evalExpr(s.value, i);
        series[outIdx][i] = Number.isFinite(v) ? v : null;
        outIdx++;
      }
    }
  }

  return { series };
}
