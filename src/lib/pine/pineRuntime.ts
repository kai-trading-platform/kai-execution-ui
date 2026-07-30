// Runtime del subset Pine de Kai: evalúa el programa BARRA A BARRA respetando
// la semántica de series de TradingView — cada call-site ta.* (identificado por
// siteId del AST) mantiene su PROPIO estado (EMA previa, ventana rodante, prevs
// de crossover), de modo que dos ta.ema(close, 9) en líneas distintas no se
// contaminan entre sí. NaN modela `na`: se propaga en aritmética, compara a
// false y al final se convierte a null (lo que klinecharts espera como hueco).

import { Expr, Stmt, PineError, BUILTIN_SERIES, evalColorExpr } from "./pineParser";

export interface PineBar {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Timestamp ms (opcional; para las horas de los trades del Probador). */
  time?: number;
}

// ── Probador de estrategias ──────────────────────────────────────────────────

export interface StrategyTrade {
  side: "long" | "short";
  entryPrice: number;
  entryTime: number | null;
  exitPrice: number;
  exitTime: number | null;
  /** PnL en puntos de precio por 1 unidad. */
  pnl: number;
  /** Cómo se cerró: señal, stop, limit o fin de datos. */
  exitReason: "signal" | "stop" | "limit" | "end";
}

export interface StrategyReport {
  trades: StrategyTrade[];
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  winRate: number | null;
  maxDrawdown: number;
  initialCapital: number;
  /** Curva de equity (capital + PnL acumulado en puntos) por barra. */
  equity: number[];
  openPosition: { side: "long" | "short"; entryPrice: number; unrealized: number } | null;
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

/** ta.macd: tres EMAs encadenadas (rápida, lenta, señal). */
interface MacdState {
  fast: EmaState;
  slow: EmaState;
  sig: EmaState;
}

/** ta.dmi: previos + RMA de Wilder (misma forma que EmaState) de TR/+DM/−DM/DX. */
interface DmiState {
  prevHigh: number;
  prevLow: number;
  prevClose: number;
  tr: EmaState;
  plus: EmaState;
  minus: EmaState;
  adx: EmaState;
}

type SiteState = EmaState | WindowState | RsiState | PrevState | ChangeState | MacdState | DmiState | Record<string, number>;

// Paso EMA de Pico (siembra con SMA(len), luego suavizado exponencial). Comparte
// forma con el `case "ema"` de evalCall; lo reusan ta.macd (multi-retorno).
function emaStep(st: EmaState, src: number): number {
  if (Number.isNaN(src)) return st.prev;
  if (Number.isNaN(st.prev)) {
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

// Paso RMA de Wilder (siembra con SMA(len), luego media móvil de Wilder). Igual
// que el suavizado de ta.atr/ta.rsi; lo reusa ta.dmi.
function rmaStep(st: EmaState, x: number): number {
  if (Number.isNaN(x)) return st.prev;
  if (Number.isNaN(st.prev)) {
    st.sum += x;
    st.count++;
    if (st.count < st.len) return NaN;
    st.prev = st.sum / st.len;
    return st.prev;
  }
  st.prev = (st.prev * (st.len - 1) + x) / st.len;
  return st.prev;
}

// ── Ejecutor ─────────────────────────────────────────────────────────────────

/** Dibujo de caja (box.*): coordenadas en (bar_index, precio). */
export interface BoxDrawing {
  left: number;
  top: number;
  right: number;
  bottom: number;
  bgColor: string;
  borderColor: string;
  borderWidth: number;
}
/** Dibujo de línea (line.*): dos puntos en (bar_index, precio). */
export interface LineDrawing {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  width: number;
  style: string;
}
/** Dibujo de etiqueta (label.*): un punto (bar_index, precio) + texto. */
export interface LabelDrawing {
  x: number;
  y: number;
  text: string;
  color: string;
  textColor: string;
  style: string;
  size: string;
}
/** Celda de tabla (table.cell): fila/columna dentro de una tabla. */
export interface TableCellDrawing {
  col: number;
  row: number;
  text: string;
  textColor: string;
  textSize: string;
}
/** Dibujo de tabla (table.*): panel fijo en una esquina con celdas. */
export interface TableDrawing {
  position: string;
  columns: number;
  rows: number;
  borderWidth: number;
  cells: TableCellDrawing[];
}
export interface Drawings {
  boxes: BoxDrawing[];
  lines: LineDrawing[];
  labels: LabelDrawing[];
  tables: TableDrawing[];
}

export interface RunResult {
  /** Una entrada por plot/hline (en orden de aparición): serie de valores. */
  series: Array<Array<number | null>>;
  /** Solo para strategy(): reporte del Probador. */
  strategy: StrategyReport | null;
  /** Cajas y líneas vivas (no borradas) al final del recorrido. */
  drawings: Drawings;
}

export interface RunOptions {
  isStrategy?: boolean;
  initialCapital?: number;
  /** Zona horaria del símbolo (syminfo.timezone). Por defecto "UTC". */
  timezone?: string;
  /** Minutos por barra (timeframe.*). Si se omite se infiere de los timestamps. */
  timeframeMinutes?: number;
}

/** Infiere minutos por barra del espaciado mediano entre timestamps. */
function inferTimeframeMinutes(bars: PineBar[]): number {
  const diffs: number[] = [];
  for (let k = 1; k < bars.length && diffs.length < 50; k++) {
    const a = bars[k - 1].time;
    const b = bars[k].time;
    if (typeof a === "number" && typeof b === "number" && b > a) diffs.push((b - a) / 60000);
  }
  if (!diffs.length) return 1; // sin timestamps → asumimos 1m
  diffs.sort((x, y) => x - y);
  return Math.max(1, Math.round(diffs[Math.floor(diffs.length / 2)]));
}

/** Offset en minutos de un string de zona tipo "UTC-4" / "UTC+5:30". 0 si no parsea. */
function tzOffsetMinutes(tz: string): number {
  const m = tz.match(/UTC\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?/i);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0));
}

/** ¿El instante `ms` cae dentro de la sesión "HHMM-HHMM" en la zona `tz`? */
function inSessionTime(ms: number, session: string, tz: string): boolean {
  const m = session.match(/^(\d{2})(\d{2})-(\d{2})(\d{2})/);
  if (!m) return false;
  const start = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  const end = parseInt(m[3], 10) * 60 + parseInt(m[4], 10);
  // Minuto del día en la zona local (UTC + offset).
  const localMs = ms + tzOffsetMinutes(tz) * 60000;
  const d = new Date(localMs);
  const mod = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (start === end) return true; // sesión de 24h
  if (start < end) return mod >= start && mod < end;
  return mod >= start || mod < end; // sesión que cruza medianoche
}

/** Minutos → string de timeframe estilo TradingView (period). */
function minutesToTf(min: number): string {
  if (min < 1) return "1S";
  if (min < 60) return String(min);
  if (min < 1440) return `${Math.round(min / 60)}H`;
  if (min < 10080) return "1D";
  if (min < 43200) return "1W";
  return "1M";
}

export function runPine(statements: Stmt[], bars: PineBar[], opts: RunOptions = {}): RunResult {
  const n = bars.length;

  // Contexto de símbolo/temporalidad. Sin metadatos reales, inferimos el
  // timeframe del espaciado mediano entre barras con timestamp; si no hay
  // timestamps, asumimos intradía 1m (lo más común en el terminal).
  const ctxTimezone = opts.timezone ?? "UTC";
  const ctxTfMinutes = opts.timeframeMinutes ?? inferTimeframeMinutes(bars);
  const ctxTimeframe = minutesToTf(ctxTfMinutes);

  const varBuffers = new Map<string, Float64Array>();
  const siteStates = new Map<number, SiteState>();
  // `var`/`varip`: nombres que persisten entre barras (init una vez, luego arrastran).
  const varNames = new Set<string>();
  const varInitialized = new Set<string>();

  // Funciones de usuario (nombre → definición) y pila de ámbitos locales para
  // sus parámetros/variables. Las locales tapan a las globales mientras se
  // ejecuta el cuerpo; fuera, la pila está vacía y todo va a varBuffers.
  const userFuncs = new Map<string, Extract<Stmt, { kind: "funcdef" }>>();
  for (const s of statements) if (s.kind === "funcdef") userFuncs.set(s.name, s);
  const localScopes: Map<string, number>[] = [];
  const localTop = (): Map<string, number> | null => (localScopes.length ? localScopes[localScopes.length - 1] : null);

  // Registro de objetos no-numéricos (arrays; luego boxes/lines/labels/tables).
  // Todo en el runtime es un número: un objeto se modela como un "handle"
  // numérico que indexa este mapa. Así `var box[] xs = array.new_box()` guarda
  // el handle en el buffer y el objeto real (aquí, un Array JS) persiste vivo y
  // se acumula entre barras igual que en Pine.
  const objectRegistry = new Map<number, unknown>();
  // Los handles (strings/arrays/boxes/…) viven en un rango alto que ni precios
  // ni contadores reales alcanzan. Sin esto, str.tostring(wins) con wins=1
  // colisionaría con el handle 1 (el primer string interno) y pintaría ese
  // texto en vez del número. Sigue siendo entero exacto (< 2^53).
  const HANDLE_BASE = 1e12;
  let nextHandle = HANDLE_BASE;
  const newHandle = (obj: unknown): number => {
    const h = nextHandle++;
    objectRegistry.set(h, obj);
    return h;
  };
  const getArray = (h: number): number[] => {
    const a = objectRegistry.get(h);
    if (!Array.isArray(a)) throw new PineError(`Handle de array inválido: ${h}`, 0);
    return a as number[];
  };

  // Interning de strings: cada texto único obtiene un handle estable, así que
  // dos literales iguales comparan igual (== sobre handles) igual que en Pine.
  const stringPool = new Map<string, number>();
  const internString = (s: string): number => {
    let h = stringPool.get(s);
    if (h === undefined) {
      h = newHandle(s);
      stringPool.set(s, h);
    }
    return h;
  };
  const getString = (h: number): string | null => {
    const v = objectRegistry.get(h);
    return typeof v === "string" ? v : null;
  };

  // Dibujos vivos. Cada box/line se guarda por handle (para que set_*/delete lo
  // muten y `var` lo mantenga entre barras) y en orden de creación para el
  // volcado final. `deleted` lo saca del render sin romper handles existentes.
  interface BoxObj extends BoxDrawing {
    _deleted: boolean;
  }
  interface LineObj extends LineDrawing {
    _deleted: boolean;
  }
  interface LabelObj extends LabelDrawing {
    _deleted: boolean;
  }
  interface TableObj extends TableDrawing {
    _deleted: boolean;
  }
  const allBoxes: BoxObj[] = [];
  const allLines: LineObj[] = [];
  const allLabels: LabelObj[] = [];
  const allTables: TableObj[] = [];
  const getBox = (h: number): BoxObj | null => {
    const v = objectRegistry.get(h);
    return v && typeof v === "object" && "bottom" in v ? (v as BoxObj) : null;
  };
  const getLine = (h: number): LineObj | null => {
    const v = objectRegistry.get(h);
    return v && typeof v === "object" && "x2" in v ? (v as LineObj) : null;
  };
  const getLabel = (h: number): LabelObj | null => {
    const v = objectRegistry.get(h);
    return v && typeof v === "object" && "text" in v && "y" in v ? (v as LabelObj) : null;
  };
  const getTable = (h: number): TableObj | null => {
    const v = objectRegistry.get(h);
    return v && typeof v === "object" && "cells" in v ? (v as TableObj) : null;
  };
  // Resuelve un argumento de color (handle de string CSS) → CSS, con defecto.
  const colorArg = (e: Extract<Expr, { kind: "call" }>, key: string, dflt: string, i: number): string => {
    const arg = e.named[key];
    if (!arg) return dflt;
    const s = getString(evalExpr(arg, i));
    return s ?? dflt;
  };
  const numArg = (e: Extract<Expr, { kind: "call" }>, key: string, dflt: number, i: number): number => {
    const arg = e.named[key];
    if (!arg) return dflt;
    const v = evalExpr(arg, i);
    return Number.isNaN(v) ? dflt : v;
  };

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
        return internString(e.value); // handle numérico del texto
      case "arraylit":
        // Los literales `[…]` solo se usan como metadata de los input.* (options),
        // y ahí resolveInputs los descarta: nunca deberían llegar a evaluarse.
        throw new PineError(
          "Un literal de array '[…]' solo se admite en 'options=' de los input.*; no puede usarse como valor",
          e.line,
        );
      case "ident": {
        if (e.name === "true") return 1;
        if (e.name === "false") return 0;
        if (e.name === "na") return NaN;
        if (e.name === "bar_index") return i;
        if (e.name === "time") return bars[i]?.time ?? NaN;
        if (e.name === "time_close") return bars[i]?.time ?? NaN;
        if (e.name === "last_bar_index") return n - 1;
        const sc = localTop();
        if (sc && sc.has(e.name)) return sc.get(e.name)!;
        if (BUILTIN_SERIES.has(e.name)) return builtinAt(e.name, i);
        const buf = varBuffers.get(e.name);
        return buf ? buf[i] : NaN;
      }
      case "member":
        if (e.ns === "color") return internString(evalColorExpr(e, "#000000"));
        // Enums de estilo/tamaño/posición: se modelan como el texto del sufijo.
        if (e.ns === "line" || e.ns === "label" || e.ns === "plot") return internString(e.name.replace("style_", ""));
        if (e.ns === "size" || e.ns === "position") return internString(e.name);
        if (e.ns === "strategy") {
          switch (e.name) {
            case "long":
              return 1;
            case "short":
              return -1;
            case "position_size":
              return broker.pos;
            case "position_avg_price":
              return broker.pos !== 0 ? broker.avgPrice : NaN;
          }
        }
        if (e.ns === "syminfo") {
          switch (e.name) {
            case "timezone":
              return internString(ctxTimezone);
            case "mintick":
              return 0.01;
            case "pointvalue":
              return 1;
            default:
              return internString(""); // tickerid/ticker/… texto neutro
          }
        }
        if (e.ns === "timeframe") {
          switch (e.name) {
            case "period":
              return internString(ctxTimeframe);
            case "multiplier":
              return ctxTfMinutes || NaN;
            case "isintraday":
              return ctxTfMinutes > 0 && ctxTfMinutes < 1440 ? 1 : 0;
            case "isdaily":
              return ctxTfMinutes === 1440 ? 1 : 0;
            case "isweekly":
            case "ismonthly":
            case "isseconds":
              return 0;
            case "isminutes":
              return ctxTfMinutes > 0 && ctxTfMinutes < 1440 ? 1 : 0;
            case "isdwm":
              return ctxTfMinutes >= 1440 ? 1 : 0;
            default:
              return NaN;
          }
        }
        if (e.ns === "barstate") {
          switch (e.name) {
            case "islast":
            case "islastconfirmedhistory":
              return i === n - 1 ? 1 : 0;
            case "isfirst":
              return i === 0 ? 1 : 0;
            case "isconfirmed":
            case "ishistory":
              return 1; // backtest: toda barra está cerrada/confirmada
            case "isnew":
              return 1;
            case "isrealtime":
              return 0;
            default:
              return NaN;
          }
        }
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
          case "+": {
            // Camino rápido: si ambos operandos están por DEBAJO de HANDLE_BASE
            // son números reales → suma directa sin tocar el Map de strings.
            // Solo cuando alguno pisa el rango handle miramos si es texto para
            // concatenar (str + str, str + num). Esto evita 2 lookups de Map en
            // CADA suma aritmética (hotspot del intérprete barra a barra).
            if (a >= HANDLE_BASE || b >= HANDLE_BASE) {
              const sa = getString(a);
              const sb = getString(b);
              if (sa !== null || sb !== null) {
                return internString((sa ?? String(a)) + (sb ?? String(b)));
              }
            }
            return a + b;
          }
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

  function callUserFunc(fn: Extract<Stmt, { kind: "funcdef" }>, e: Extract<Expr, { kind: "call" }>, i: number): number {
    // Evaluar argumentos en el ámbito ACTUAL, antes de abrir el nuevo.
    const scope = new Map<string, number>();
    for (let k = 0; k < fn.params.length; k++) {
      const p = fn.params[k];
      if (k < e.args.length) scope.set(p.name, evalExpr(e.args[k], i));
      else if (e.named[p.name] !== undefined) scope.set(p.name, evalExpr(e.named[p.name], i));
      else if (p.default) scope.set(p.name, evalExpr(p.default, i));
      else scope.set(p.name, NaN);
    }
    // Argumentos por nombre que no fueron posicionales.
    for (const [key, expr] of Object.entries(e.named)) {
      if (fn.params.some((p) => p.name === key) && !scope.has(key)) scope.set(key, evalExpr(expr, i));
    }
    localScopes.push(scope);
    let ret = NaN;
    try {
      for (let j = 0; j < fn.body.length; j++) {
        const st = fn.body[j];
        if (st.kind === "exprstmt") {
          const v = evalExpr(st.expr, i);
          if (j === fn.body.length - 1) ret = v;
        } else {
          execStmts([st], i);
        }
      }
    } finally {
      localScopes.pop();
    }
    return ret;
  }

  // array.* — devuelve un número: un handle (new_*), un valor leído
  // (get/pop/shift/size/first/last) o NaN para las que no producen valor.
  function evalArray(e: Extract<Expr, { kind: "call" }>, i: number): number {
    const args = e.args.map((a) => evalExpr(a, i));
    if (e.name.startsWith("new_")) {
      // new_float(size, initial) / new_box() … El objeto real puede acumular
      // handles (boxes/lines) o números; en todos los casos es un Array JS.
      const size = args.length >= 1 && Number.isFinite(args[0]) ? Math.max(0, Math.trunc(args[0])) : 0;
      const initial = args.length >= 2 ? args[1] : NaN;
      return newHandle(new Array<number>(size).fill(initial));
    }
    const arr = getArray(args[0]);
    switch (e.name) {
      case "push":
        arr.push(args[1]);
        return NaN;
      case "unshift":
        arr.unshift(args[1]);
        return NaN;
      case "pop":
        return arr.length ? (arr.pop() as number) : NaN;
      case "shift":
        return arr.length ? (arr.shift() as number) : NaN;
      case "size":
        return arr.length;
      case "clear":
        arr.length = 0;
        return NaN;
      case "first":
        return arr.length ? arr[0] : NaN;
      case "last":
        return arr.length ? arr[arr.length - 1] : NaN;
      case "get": {
        const idx = Math.trunc(args[1]);
        return idx >= 0 && idx < arr.length ? arr[idx] : NaN;
      }
      case "set": {
        const idx = Math.trunc(args[1]);
        if (idx >= 0 && idx < arr.length) arr[idx] = args[2];
        return NaN;
      }
      case "remove": {
        const idx = Math.trunc(args[1]);
        if (idx >= 0 && idx < arr.length) return arr.splice(idx, 1)[0];
        return NaN;
      }
      case "insert": {
        const idx = Math.trunc(args[1]);
        arr.splice(Math.max(0, Math.min(idx, arr.length)), 0, args[2]);
        return NaN;
      }
      default:
        return NaN;
    }
  }

  // box.* / line.* — crean o mutan dibujos. new devuelve un handle; set_*/delete
  // devuelven NaN. Las coordenadas x son bar_index; las y, precio.
  function evalDraw(e: Extract<Expr, { kind: "call" }>, i: number): number {
    const a = e.args.map((arg) => evalExpr(arg, i));
    // Coordenada por posición o por nombre (Pine acepta ambas): box.new(l,t,r,b)
    // o box.new(left=…, top=…). Ausente → NaN (no undefined).
    const coord = (idx: number, name: string): number => {
      if (e.named[name]) return evalExpr(e.named[name], i);
      return idx < a.length ? a[idx] : NaN;
    };
    if (e.ns === "box") {
      if (e.name === "new") {
        const box: BoxObj = {
          left: coord(0, "left"),
          top: coord(1, "top"),
          right: coord(2, "right"),
          bottom: coord(3, "bottom"),
          bgColor: colorArg(e, "bgcolor", "rgba(41,98,255,0.15)", i),
          borderColor: colorArg(e, "border_color", "#2962ff", i),
          borderWidth: numArg(e, "border_width", 1, i),
          _deleted: false,
        };
        allBoxes.push(box);
        return newHandle(box);
      }
      const box = getBox(a[0]);
      if (!box) return NaN;
      switch (e.name) {
        case "set_top": box.top = a[1]; return NaN;
        case "set_bottom": box.bottom = a[1]; return NaN;
        case "set_left": box.left = a[1]; return NaN;
        case "set_right": box.right = a[1]; return NaN;
        case "set_lefttop": box.left = a[1]; box.top = a[2]; return NaN;
        case "set_rightbottom": box.right = a[1]; box.bottom = a[2]; return NaN;
        case "set_bgcolor": box.bgColor = getString(a[1]) ?? box.bgColor; return NaN;
        case "set_border_color": box.borderColor = getString(a[1]) ?? box.borderColor; return NaN;
        case "set_border_width": box.borderWidth = a[1]; return NaN;
        case "delete": box._deleted = true; return NaN;
        default: return NaN;
      }
    }
    // line.*
    if (e.name === "new") {
      const style = e.named.style ? getString(evalExpr(e.named.style, i)) : "solid";
      const line: LineObj = {
        x1: coord(0, "x1"),
        y1: coord(1, "y1"),
        x2: coord(2, "x2"),
        y2: coord(3, "y2"),
        color: colorArg(e, "color", "#2962ff", i),
        width: numArg(e, "width", 1, i),
        style: style ?? "solid",
        _deleted: false,
      };
      allLines.push(line);
      return newHandle(line);
    }
    const line = getLine(a[0]);
    if (!line) return NaN;
    switch (e.name) {
      case "set_xy1": line.x1 = a[1]; line.y1 = a[2]; return NaN;
      case "set_xy2": line.x2 = a[1]; line.y2 = a[2]; return NaN;
      case "set_x1": line.x1 = a[1]; return NaN;
      case "set_y1": line.y1 = a[1]; return NaN;
      case "set_x2": line.x2 = a[1]; return NaN;
      case "set_y2": line.y2 = a[1]; return NaN;
      case "set_color": line.color = getString(a[1]) ?? line.color; return NaN;
      case "set_width": line.width = a[1]; return NaN;
      case "set_style": line.style = getString(a[1]) ?? line.style; return NaN;
      case "delete": line._deleted = true; return NaN;
      default: return NaN;
    }
  }

  // label.* / table.* — etiquetas de texto y paneles de tabla. new devuelve un
  // handle; set_*/cell/clear/delete devuelven NaN.
  function evalLabelTable(e: Extract<Expr, { kind: "call" }>, i: number): number {
    const a = e.args.map((arg) => evalExpr(arg, i));
    const coord = (idx: number, name: string): number => {
      if (e.named[name]) return evalExpr(e.named[name], i);
      return idx < a.length ? a[idx] : NaN;
    };
    const strArg = (idx: number, name: string, def: string): string => {
      if (e.named[name]) return getString(evalExpr(e.named[name], i)) ?? def;
      return idx < a.length ? (getString(a[idx]) ?? def) : def;
    };
    if (e.ns === "label") {
      if (e.name === "new") {
        const label: LabelObj = {
          x: coord(0, "x"),
          y: coord(1, "y"),
          text: strArg(2, "text", ""),
          color: colorArg(e, "color", "#2962ff", i),
          textColor: colorArg(e, "textcolor", "#ffffff", i),
          style: strArg(-1, "style", "label_down"),
          size: strArg(-1, "size", "normal"),
          _deleted: false,
        };
        allLabels.push(label);
        return newHandle(label);
      }
      const label = getLabel(a[0]);
      if (!label) return NaN;
      switch (e.name) {
        case "set_x": label.x = a[1]; return NaN;
        case "set_y": label.y = a[1]; return NaN;
        case "set_xy": label.x = a[1]; label.y = a[2]; return NaN;
        case "set_text": label.text = getString(a[1]) ?? label.text; return NaN;
        case "set_color": label.color = getString(a[1]) ?? label.color; return NaN;
        case "set_textcolor": label.textColor = getString(a[1]) ?? label.textColor; return NaN;
        case "set_style": label.style = getString(a[1]) ?? label.style; return NaN;
        case "set_size": label.size = getString(a[1]) ?? label.size; return NaN;
        case "delete": label._deleted = true; return NaN;
        default: return NaN;
      }
    }
    // table.*
    if (e.name === "new") {
      const table: TableObj = {
        position: strArg(0, "position", "top_right"),
        columns: Math.trunc(coord(1, "columns")) || 0,
        rows: Math.trunc(coord(2, "rows")) || 0,
        borderWidth: numArg(e, "border_width", 0, i),
        cells: [],
        _deleted: false,
      };
      allTables.push(table);
      return newHandle(table);
    }
    const table = getTable(a[0]);
    if (!table) return NaN;
    switch (e.name) {
      case "cell": {
        const col = Math.trunc(a[1]);
        const row = Math.trunc(a[2]);
        const text = getString(a[3]) ?? "";
        const existing = table.cells.find((c) => c.col === col && c.row === row);
        const textColor = e.named.text_color ? getString(evalExpr(e.named.text_color, i)) ?? "#ffffff" : "#ffffff";
        const textSize = e.named.text_size ? getString(evalExpr(e.named.text_size, i)) ?? "normal" : "normal";
        if (existing) {
          existing.text = text;
          existing.textColor = textColor;
          existing.textSize = textSize;
        } else {
          table.cells.push({ col, row, text, textColor, textSize });
        }
        return NaN;
      }
      case "set_cell_text": {
        const col = Math.trunc(a[1]);
        const row = Math.trunc(a[2]);
        const cell = table.cells.find((c) => c.col === col && c.row === row);
        if (cell) cell.text = getString(a[3]) ?? cell.text;
        return NaN;
      }
      case "clear": table.cells = []; return NaN;
      case "delete": table._deleted = true; return NaN;
      default: return NaN;
    }
  }

  function evalCall(e: Extract<Expr, { kind: "call" }>, i: number): number {
    if (e.ns === null) {
      // Funciones globales integradas antes que las de usuario.
      switch (e.name) {
        case "na":
          return Number.isNaN(evalExpr(e.args[0], i)) ? 1 : 0;
        case "nz": {
          const v = evalExpr(e.args[0], i);
          if (!Number.isNaN(v)) return v;
          return e.args.length > 1 ? evalExpr(e.args[1], i) : 0;
        }
        case "hour":
        case "minute":
        case "second":
        case "dayofweek":
        case "dayofmonth":
        case "month":
        case "year": {
          // f() usa el tiempo de la barra; f(t) un tiempo dado; f(t, tz) con zona.
          const t0 = e.args.length >= 1 ? evalExpr(e.args[0], i) : bars[i]?.time;
          if (typeof t0 !== "number" || !Number.isFinite(t0)) return NaN;
          const tzArg = e.args.length >= 2 ? getString(evalExpr(e.args[1], i)) : null;
          const d = new Date(t0 + tzOffsetMinutes(tzArg ?? ctxTimezone) * 60000);
          switch (e.name) {
            case "hour":
              return d.getUTCHours();
            case "minute":
              return d.getUTCMinutes();
            case "second":
              return d.getUTCSeconds();
            case "dayofweek":
              return d.getUTCDay() + 1; // Pine: domingo = 1
            case "dayofmonth":
              return d.getUTCDate();
            case "month":
              return d.getUTCMonth() + 1;
            default:
              return d.getUTCFullYear();
          }
        }
        case "fill":
          // Compatibilidad: se acepta y no pinta relleno (ambas series se ven).
          return NaN;
        case "timenow":
          return bars[n - 1]?.time ?? NaN;
        case "timestamp":
          return NaN; // sin calendario real
        case "alertcondition":
          return NaN; // no-op en backtest
        case "time": {
          const t = bars[i]?.time;
          if (typeof t !== "number") return NaN;
          // time(period) → tiempo de la barra. time(period, session, tz) →
          // tiempo si la barra cae dentro de la sesión, si no na.
          if (e.args.length >= 2) {
            const sess = getString(evalExpr(e.args[1], i));
            const tz = e.args.length >= 3 ? getString(evalExpr(e.args[2], i)) : ctxTimezone;
            if (sess && inSessionTime(t, sess, tz ?? ctxTimezone)) return t;
            return NaN;
          }
          return t;
        }
      }
      const fn = userFuncs.get(e.name);
      if (fn) return callUserFunc(fn, e, i);
      return NaN;
    }
    if (e.ns === "color") {
      // Colores → handle de string CSS (evaluación estática vía el parser).
      return internString(evalColorExpr(e, "#000000"));
    }
    if (e.ns === "box" || e.ns === "line") {
      return evalDraw(e, i);
    }
    if (e.ns === "str") {
      // str.tostring(x) / str.tostring(x, format) → handle de texto.
      if (e.name === "tostring") {
        const v = evalExpr(e.args[0], i);
        if (Number.isNaN(v)) return internString("NaN");
        const s = getString(v);
        if (s !== null) return internString(s); // ya era texto
        // Formato numérico opcional: "#.##"/"0.0"/… → nº de decimales según los
        // caracteres tras el punto; "#.#####" mantiene hasta 5. Sin formato,
        // representación por defecto.
        if (e.args.length > 1) {
          const fmt = getString(evalExpr(e.args[1], i));
          if (fmt) {
            const dot = fmt.indexOf(".");
            const decimals = dot >= 0 ? fmt.length - dot - 1 : 0;
            return internString(v.toFixed(Math.max(0, Math.min(20, decimals))));
          }
        }
        return internString(String(v));
      }
      return internString("");
    }
    if (e.ns === "array") {
      return evalArray(e, i);
    }
    if (e.ns === "timeframe" && e.name === "change") {
      // Clave del periodo (día/semana/mes) en la zona del símbolo; cambia → true.
      const t = bars[i]?.time;
      if (typeof t !== "number") return 0;
      const tf = (getString(evalExpr(e.args[0], i)) ?? "D").toUpperCase();
      const d = new Date(t + tzOffsetMinutes(ctxTimezone) * 60000);
      let key: string;
      if (tf.includes("M") && !tf.includes("MIN")) key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
      else if (tf.includes("W")) {
        const day = d.getUTCDay();
        const monday = new Date(d.getTime() - ((day + 6) % 7) * 86400000);
        key = `${monday.getUTCFullYear()}-${monday.getUTCMonth()}-${monday.getUTCDate()}`;
      } else key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
      const st = (siteStates.get(e.siteId) as Record<string, number> | undefined) ?? {};
      const prev = (st as unknown as { key?: string }).key;
      (st as unknown as { key?: string }).key = key;
      siteStates.set(e.siteId, st);
      return prev === undefined ? 0 : prev === key ? 0 : 1;
    }
    if (e.ns === "math") {
      // math.sum(src, len): suma rodante — necesita estado POR CALL-SITE, así que
      // se resuelve antes de evaluar el resto de argumentos como valores sueltos.
      if (e.name === "sum") {
        const v = evalExpr(e.args[0], i);
        const len = constLen(e.args[1], e.line);
        let st = siteStates.get(e.siteId) as WindowState | undefined;
        if (!st) {
          st = { values: [] };
          siteStates.set(e.siteId, st);
        }
        st.values.push(v);
        if (st.values.length > len) st.values.shift();
        if (st.values.length < len) return NaN;
        let acc = 0;
        for (const x of st.values) acc += x;
        return acc;
      }
      const args = e.args.map((a) => evalExpr(a, i));
      switch (e.name) {
        case "log10":
          return Math.log10(args[0]);
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
        case "avg":
          return args.length ? args.reduce((s, x) => s + x, 0) / args.length : NaN;
        case "sign":
          return Math.sign(args[0]);
        case "exp":
          return Math.exp(args[0]);
        default:
          return NaN;
      }
    }
    if (e.ns === "label" || e.ns === "table") {
      return evalLabelTable(e, i);
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

  // Evalúa una llamada ta.* multi-retorno (RHS de una desestructuración) y
  // devuelve sus valores en orden. Estado por call-site (persiste entre barras),
  // igual que las ta.* escalares.
  function evalTuple(e: Extract<Expr, { kind: "call" }>, i: number): number[] {
    switch (e.name) {
      case "macd": {
        const src = evalExpr(e.args[0], i);
        const fastLen = constLen(e.args[1], e.line);
        const slowLen = constLen(e.args[2], e.line);
        const sigLen = constLen(e.args[3], e.line);
        let st = siteStates.get(e.siteId) as MacdState | undefined;
        if (!st) {
          st = {
            fast: { len: fastLen, sum: 0, count: 0, prev: NaN },
            slow: { len: slowLen, sum: 0, count: 0, prev: NaN },
            sig: { len: sigLen, sum: 0, count: 0, prev: NaN },
          };
          siteStates.set(e.siteId, st);
        }
        const fast = emaStep(st.fast, src);
        const slow = emaStep(st.slow, src);
        const macdLine = fast - slow; // NaN hasta que ambas EMAs siembran
        const signal = emaStep(st.sig, macdLine);
        const hist = macdLine - signal;
        return [macdLine, signal, hist];
      }
      case "bb": {
        const src = evalExpr(e.args[0], i);
        const len = constLen(e.args[1], e.line);
        const mult = evalExpr(e.args[2], i);
        let st = siteStates.get(e.siteId) as WindowState | undefined;
        if (!st) {
          st = { values: [] };
          siteStates.set(e.siteId, st);
        }
        st.values.push(src);
        if (st.values.length > len) st.values.shift();
        if (st.values.length < len || st.values.some(Number.isNaN)) return [NaN, NaN, NaN];
        const w = st.values;
        const mean = w.reduce((s, v) => s + v, 0) / len;
        const variance = w.reduce((s, v) => s + (v - mean) * (v - mean), 0) / len; // stdev poblacional (= ta.stdev)
        const sd = Math.sqrt(variance);
        return [mean, mean + mult * sd, mean - mult * sd];
      }
      case "dmi": {
        const diLen = constLen(e.args[0], e.line);
        const adxLen = constLen(e.args[1], e.line);
        let st = siteStates.get(e.siteId) as DmiState | undefined;
        if (!st) {
          st = {
            prevHigh: NaN,
            prevLow: NaN,
            prevClose: NaN,
            tr: { len: diLen, sum: 0, count: 0, prev: NaN },
            plus: { len: diLen, sum: 0, count: 0, prev: NaN },
            minus: { len: diLen, sum: 0, count: 0, prev: NaN },
            adx: { len: adxLen, sum: 0, count: 0, prev: NaN },
          };
          siteStates.set(e.siteId, st);
        }
        const b = bars[i];
        if (Number.isNaN(st.prevHigh)) {
          st.prevHigh = b.high;
          st.prevLow = b.low;
          st.prevClose = b.close;
          return [NaN, NaN, NaN]; // primera barra: sin movimiento direccional
        }
        const up = b.high - st.prevHigh;
        const down = st.prevLow - b.low;
        const plusDM = up > down && up > 0 ? up : 0;
        const minusDM = down > up && down > 0 ? down : 0;
        const tr = Math.max(b.high - b.low, Math.abs(b.high - st.prevClose), Math.abs(b.low - st.prevClose));
        st.prevHigh = b.high;
        st.prevLow = b.low;
        st.prevClose = b.close;
        const smTr = rmaStep(st.tr, tr);
        const smPlus = rmaStep(st.plus, plusDM);
        const smMinus = rmaStep(st.minus, minusDM);
        if (Number.isNaN(smTr) || smTr === 0) return [NaN, NaN, NaN];
        const plusDI = (100 * smPlus) / smTr;
        const minusDI = (100 * smMinus) / smTr;
        const sumDI = plusDI + minusDI;
        const dx = sumDI === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / sumDI;
        const adx = rmaStep(st.adx, dx);
        return [plusDI, minusDI, adx];
      }
    }
    return [NaN, NaN, NaN];
  }

  // Prepara buffers de variables (asignaciones a cualquier profundidad)
  const ensureBuffer = (name: string): void => {
    if (!varBuffers.has(name)) {
      const buf = new Float64Array(n);
      buf.fill(NaN);
      varBuffers.set(name, buf);
    }
  };
  const collectAssigns = (stmts: Stmt[]): void => {
    for (const s of stmts) {
      if (s.kind === "assign" || s.kind === "reassign") {
        ensureBuffer(s.name);
        if (s.kind === "assign" && s.isVar) varNames.add(s.name);
      }
      if (s.kind === "destructure") {
        for (const nm of s.names) ensureBuffer(nm);
      }
      if (s.kind === "if") {
        collectAssigns(s.then);
        if (s.else) collectAssigns(s.else);
      }
      if (s.kind === "for") {
        ensureBuffer(s.varName);
        collectAssigns(s.body);
      }
      if (s.kind === "while") {
        collectAssigns(s.body);
      }
    }
  };
  collectAssigns(statements);

  // ── Broker simulado (Probador) ─────────────────────────────────────────────
  // Semántica MVP documentada: las órdenes de señal (entry/close) se ejecutan
  // al CIERRE de la barra de la señal; stop/limit de strategy.exit se evalúan
  // contra el high/low de las barras SIGUIENTES (gap → se llena al open). Si
  // stop y limit caen en la misma barra gana el stop (conservador). Tamaño
  // fijo: 1 unidad; PnL en puntos de precio.
  const initialCapital = opts.initialCapital ?? 10_000;
  const trades: StrategyTrade[] = [];
  const equity: number[] = new Array(n).fill(initialCapital);
  let realized = 0;

  const broker: {
    pos: number; // 1 long, -1 short, 0 flat (1 unidad fija en fase 2)
    avgPrice: number;
    entryTime: number | null;
    stop: number | null;
    limit: number | null;
  } = { pos: 0, avgPrice: NaN, entryTime: null, stop: null, limit: null };

  const closeTrade = (i: number, price: number, reason: StrategyTrade["exitReason"]) => {
    if (broker.pos === 0) return;
    const pnl = (price - broker.avgPrice) * broker.pos;
    trades.push({
      side: broker.pos > 0 ? "long" : "short",
      entryPrice: broker.avgPrice,
      entryTime: broker.entryTime,
      exitPrice: price,
      exitTime: bars[i]?.time ?? null,
      pnl,
      exitReason: reason,
    });
    realized += pnl;
    broker.pos = 0;
    broker.avgPrice = NaN;
    broker.entryTime = null;
    broker.stop = null;
    broker.limit = null;
  };

  const openTrade = (i: number, dir: 1 | -1) => {
    broker.pos = dir;
    broker.avgPrice = bars[i].close;
    broker.entryTime = bars[i]?.time ?? null;
    broker.stop = null;
    broker.limit = null;
  };

  function execStmts(stmts: Stmt[], i: number): void {
    for (const s of stmts) {
      switch (s.kind) {
        case "assign": {
          const sc = localTop();
          if (sc) {
            // Dentro de una función: variable local (no toca buffers globales).
            sc.set(s.name, evalExpr(s.expr, i));
            break;
          }
          if (s.isVar) {
            // `var`/`varip`: se inicializa la primera vez que se ejecuta; después
            // conserva el valor arrastrado desde la barra previa (ver loop principal).
            if (varInitialized.has(s.name)) break;
            varInitialized.add(s.name);
          }
          varBuffers.get(s.name)![i] = evalExpr(s.expr, i);
          break;
        }
        case "reassign": {
          const sc = localTop();
          if (sc && sc.has(s.name)) {
            sc.set(s.name, evalExpr(s.expr, i));
            break;
          }
          varBuffers.get(s.name)![i] = evalExpr(s.expr, i);
          break;
        }
        case "destructure": {
          // Evalúa la llamada multi-retorno UNA vez y reparte a cada nombre.
          const vals = evalTuple(s.expr as Extract<Expr, { kind: "call" }>, i);
          const sc = localTop();
          for (let k = 0; k < s.names.length; k++) {
            const v = vals[k] ?? NaN;
            if (sc) sc.set(s.names[k], v);
            else varBuffers.get(s.names[k])![i] = v;
          }
          break;
        }
        case "exprstmt":
          evalExpr(s.expr, i); // efectos secundarios (llamadas); valor descartado
          break;
        case "funcdef":
          break; // definición: no se ejecuta por barra
        case "if":
          if (truthy(evalExpr(s.cond, i))) execStmts(s.then, i);
          else if (s.else) execStmts(s.else, i);
          break;
        case "for": {
          const from = evalExpr(s.from, i);
          const to = evalExpr(s.to, i);
          let step = s.step ? evalExpr(s.step, i) : to >= from ? 1 : -1;
          if (!Number.isFinite(from) || !Number.isFinite(to) || !Number.isFinite(step) || step === 0) break;
          const sc = localTop();
          const buf = sc ? null : varBuffers.get(s.varName)!;
          const setLoop = (v: number) => (buf ? (buf[i] = v) : sc!.set(s.varName, v));
          let guard = 0;
          for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
            if (++guard > 100_000) break; // anti-infinito
            setLoop(v);
            execStmts(s.body, i);
          }
          break;
        }
        case "while": {
          let guard = 0;
          while (truthy(evalExpr(s.cond, i))) {
            if (++guard > 100_000) break; // anti-infinito
            execStmts(s.body, i);
          }
          break;
        }
        case "strategy": {
          if (s.method === "entry") {
            const dirV = s.direction ? evalExpr(s.direction, i) : 1;
            const dir: 1 | -1 = dirV < 0 ? -1 : 1;
            if (broker.pos === dir) break; // ya en esa dirección
            if (broker.pos !== 0) closeTrade(i, bars[i].close, "signal");
            openTrade(i, dir);
          } else if (s.method === "close") {
            closeTrade(i, bars[i].close, "signal");
          } else {
            // strategy.exit(stop=, limit=): niveles para las barras siguientes.
            if (broker.pos !== 0) {
              const stopV = s.stop ? evalExpr(s.stop, i) : NaN;
              const limitV = s.limit ? evalExpr(s.limit, i) : NaN;
              broker.stop = Number.isFinite(stopV) ? stopV : broker.stop;
              broker.limit = Number.isFinite(limitV) ? limitV : broker.limit;
            }
          }
          break;
        }
        // plot/hline se manejan en el loop principal (solo top-level)
        default:
          break;
      }
    }
  }

  for (let i = 0; i < n; i++) {
    // 0) Persistencia de var/varip: arrastra el valor de la barra previa antes de
    //    ejecutar las sentencias (una reasignación `:=` posterior lo pisará).
    if (i > 0) {
      for (const vn of varNames) {
        const buf = varBuffers.get(vn)!;
        buf[i] = buf[i - 1];
      }
    }

    // 1) Stops/limits pendientes contra el rango de ESTA barra (solo estrategias).
    if (opts.isStrategy && broker.pos !== 0 && i > 0) {
      const b = bars[i];
      const dir = broker.pos;
      const stop = broker.stop;
      const limit = broker.limit;
      if (stop != null && ((dir > 0 && b.low <= stop) || (dir < 0 && b.high >= stop))) {
        const gapped = dir > 0 ? b.open <= stop : b.open >= stop;
        closeTrade(i, gapped ? b.open : stop, "stop");
      } else if (limit != null && ((dir > 0 && b.high >= limit) || (dir < 0 && b.low <= limit))) {
        const gapped = dir > 0 ? b.open >= limit : b.open <= limit;
        closeTrade(i, gapped ? b.open : limit, "limit");
      }
    }

    // 2) Sentencias del script (asignaciones, ifs, órdenes) + plots top-level.
    let outIdx = 0;
    for (const s of statements) {
      if (s.kind === "plot") {
        const v = evalExpr(s.expr, i);
        series[outIdx][i] = Number.isFinite(v) ? v : null;
        outIdx++;
      } else if (s.kind === "hline") {
        const v = evalExpr(s.value, i);
        series[outIdx][i] = Number.isFinite(v) ? v : null;
        outIdx++;
      } else {
        execStmts([s], i);
      }
    }

    // 3) Equity de la barra (realizado + flotante al cierre).
    const unrealized = broker.pos !== 0 ? (bars[i].close - broker.avgPrice) * broker.pos : 0;
    equity[i] = initialCapital + realized + unrealized;
  }

  let strategyReport: StrategyReport | null = null;
  if (opts.isStrategy) {
    const wins = trades.filter((t) => t.pnl > 0);
    const losses = trades.filter((t) => t.pnl < 0);
    const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    let peak = -Infinity;
    let maxDrawdown = 0;
    for (const v of equity) {
      if (v > peak) peak = v;
      else maxDrawdown = Math.max(maxDrawdown, peak - v);
    }
    strategyReport = {
      trades,
      netProfit: grossProfit - grossLoss,
      grossProfit,
      grossLoss,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : null,
      maxDrawdown,
      initialCapital,
      equity,
      openPosition:
        broker.pos !== 0
          ? {
              side: broker.pos > 0 ? "long" : "short",
              entryPrice: broker.avgPrice,
              unrealized: (bars[n - 1].close - broker.avgPrice) * broker.pos,
            }
          : null,
    };
  }

  const stripDeleted = <T extends { _deleted: boolean }>(xs: T[]): Omit<T, "_deleted">[] =>
    xs.filter((x) => !x._deleted).map(({ _deleted, ...rest }) => rest);
  const drawings: Drawings = {
    boxes: stripDeleted(allBoxes) as BoxDrawing[],
    lines: stripDeleted(allLines) as LineDrawing[],
    labels: stripDeleted(allLabels) as LabelDrawing[],
    tables: stripDeleted(allTables) as TableDrawing[],
  };
  return { series, strategy: strategyReport, drawings };
}
