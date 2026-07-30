// Parser del subset Pine v5 de Kai (ver docs/specs/2026-07-20-kai-pine-editor-design.md).
// Sin dependencias: tokenizer a mano + Pratt parser. Los errores llevan línea
// 1-based para que la consola del editor los marque como TradingView.
//
// Fase 2: además de indicadores, soporta ESTRATEGIAS —
//   strategy("Título", overlay=?, initial_capital=?)
//   bloques `if cond` / `else` por INDENTACIÓN (como Pine), reasignación `:=`,
//   input.int/float/bool (se evalúan a su default; panel de inputs = fase 3),
//   strategy.entry/close/exit y las series strategy.position_size / _avg_price.

export class PineError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(message);
    this.line = line;
  }
}

// ── AST ──────────────────────────────────────────────────────────────────────

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "str"; value: string }
  | { kind: "ident"; name: string; line: number }
  | { kind: "member"; ns: string; name: string; line: number }
  | {
      kind: "call";
      ns: string | null;
      name: string;
      args: Expr[];
      named: Record<string, Expr>;
      /** Id estable del call-site: el runtime guarda aquí el estado (EMA previa, ventana…). */
      siteId: number;
      line: number;
    }
  | { kind: "index"; base: Expr; offset: Expr; line: number }
  /** Literal de array `[a, b, c]`. Pine lo usa sobre todo en `options=[…]` de
   *  los input.*; ahí `resolveInputs` lo descarta (es metadata del panel). */
  | { kind: "arraylit"; items: Expr[]; line: number }
  | { kind: "unary"; op: "-" | "not"; expr: Expr }
  | { kind: "bin"; op: string; left: Expr; right: Expr }
  | { kind: "ternary"; cond: Expr; then: Expr; else: Expr };

export type StrategyMethod = "entry" | "close" | "exit";

export type Stmt =
  | { kind: "assign"; name: string; expr: Expr; isVar?: boolean; line: number }
  | { kind: "reassign"; name: string; expr: Expr; line: number }
  /** Desestructuración de tupla: `[a, b, c] = ta.macd(...)`. expr es la llamada multi-retorno. */
  | { kind: "destructure"; names: string[]; expr: Expr; line: number }
  | { kind: "plot"; expr: Expr; color: Expr | null; title: string | null; linewidth: number; line: number }
  | { kind: "hline"; value: Expr; color: Expr | null; title: string | null; line: number }
  | { kind: "if"; cond: Expr; then: Stmt[]; else: Stmt[] | null; line: number }
  | { kind: "for"; varName: string; from: Expr; to: Expr; step: Expr | null; body: Stmt[]; line: number }
  | { kind: "while"; cond: Expr; body: Stmt[]; line: number }
  | { kind: "exprstmt"; expr: Expr; line: number }
  | {
      kind: "funcdef";
      name: string;
      params: { name: string; default: Expr | null }[];
      /** Cuerpo; si la última sentencia es exprstmt, su valor es el retorno. */
      body: Stmt[];
      line: number;
    }
  | {
      kind: "strategy";
      method: StrategyMethod;
      /** entry: dirección 1 (long) / -1 (short). */
      direction: Expr | null;
      /** exit: niveles stop/limit (null si no se pasó). */
      stop: Expr | null;
      limit: Expr | null;
      line: number;
    };

export interface PineProgram {
  title: string;
  overlay: boolean;
  isStrategy: boolean;
  initialCapital: number;
  statements: Stmt[];
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

interface Token {
  type: "num" | "str" | "ident" | "op";
  value: string;
  col: number;
}

const OPS = ["=>", ":=", "==", "!=", ">=", "<=", "+=", "-=", "*=", "/=", "%=", "and", "or", "not", "?", ":", ">", "<", "+", "-", "*", "/", "%", "(", ")", "[", "]", ",", "=", "."];
// Asignaciones compuestas de Pine: `x += 1` ≡ `x := x + 1`.
const COMPOUND_ASSIGN: Record<string, string> = { "+=": "+", "-=": "-", "*=": "*", "/=": "/", "%=": "%" };

function tokenizeLine(line: string, lineNo: number): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") break; // comentario
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(line[i + 1] ?? ""))) {
      const m = /^[0-9]*\.?[0-9]+/.exec(line.slice(i))!;
      out.push({ type: "num", value: m[0], col: i });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = line.indexOf(ch, i + 1);
      if (end < 0) throw new PineError("String sin cerrar", lineNo);
      out.push({ type: "str", value: line.slice(i + 1, end), col: i });
      i = end + 1;
      continue;
    }
    if (ch === "#") {
      // Literal de color hex como TradingView: #RGB / #RGBA / #RRGGBB / #RRGGBBAA
      const m = /^#[0-9a-fA-F]{3,8}/.exec(line.slice(i));
      if (m && [4, 5, 7, 9].includes(m[0].length)) {
        out.push({ type: "str", value: m[0], col: i });
        i += m[0].length;
        continue;
      }
      throw new PineError("Color hex inválido (usa #RGB, #RRGGBB o #RRGGBBAA)", lineNo);
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i))!;
      const word = m[0];
      // and / or / not son operadores-palabra
      if (word === "and" || word === "or" || word === "not") {
        out.push({ type: "op", value: word, col: i });
      } else {
        out.push({ type: "ident", value: word, col: i });
      }
      i += word.length;
      continue;
    }
    const two = line.slice(i, i + 2);
    if (OPS.includes(two)) {
      out.push({ type: "op", value: two, col: i });
      i += 2;
      continue;
    }
    if (OPS.includes(ch)) {
      out.push({ type: "op", value: ch, col: i });
      i += 1;
      continue;
    }
    throw new PineError(`Carácter inesperado '${ch}'`, lineNo);
  }
  return out;
}

// ── Parser (Pratt) ───────────────────────────────────────────────────────────

const NAMESPACES = new Set([
  "ta", "math", "color", "input", "strategy", "array",
  "syminfo", "timeframe", "barstate", "str", "box", "line", "label", "table",
  "size", "position", "plot",
]);

// Variables/funciones integradas globales (sin namespace).
export const BUILTIN_VARS = new Set(["bar_index", "last_bar_index", "time", "time_close"]);
// Funciones globales (ns = null): nombre → aridad mínima..máxima.
const GLOBAL_FUNCTIONS: Record<string, [number, number]> = {
  na: [1, 1],
  nz: [1, 2],
  time: [0, 3],
  timenow: [0, 0],
  timestamp: [1, 6],
  alertcondition: [1, 3],
  // fill(plot1, plot2, …): se acepta para compatibilidad; el relleno no se pinta
  // (las dos series SÍ se ven como líneas).
  fill: [2, 8],
  // Componentes de fecha/hora: f(t) o f(t, timezone) — como en TradingView.
  hour: [0, 2],
  minute: [0, 2],
  second: [0, 2],
  dayofweek: [0, 2],
  dayofmonth: [0, 2],
  month: [0, 2],
  year: [0, 2],
};
// Miembros-valor por namespace (para validación; el runtime los resuelve).
const MEMBER_NAMESPACES: Record<string, Set<string>> = {
  syminfo: new Set(["timezone", "tickerid", "ticker", "mintick", "pointvalue", "type", "currency", "description"]),
  timeframe: new Set(["period", "multiplier", "isintraday", "isdaily", "isweekly", "ismonthly", "isseconds", "isminutes", "isdwm"]),
  barstate: new Set(["isconfirmed", "islast", "isnew", "isfirst", "ishistory", "isrealtime", "islastconfirmedhistory"]),
  line: new Set(["style_solid", "style_dashed", "style_dotted", "style_arrow_left", "style_arrow_right", "style_arrow_both"]),
  box: new Set([]),
  label: new Set([
    "style_none", "style_label_up", "style_label_down", "style_label_left", "style_label_right",
    "style_label_lower_left", "style_label_lower_right", "style_label_upper_left", "style_label_upper_right",
    "style_label_center", "style_arrowup", "style_arrowdown", "style_xcross", "style_cross",
    "style_circle", "style_square", "style_diamond", "style_triangleup", "style_triangledown", "style_flag", "style_text_outline",
  ]),
  size: new Set(["auto", "tiny", "small", "normal", "large", "huge"]),
  position: new Set([
    "top_left", "top_center", "top_right", "middle_left", "middle_center", "middle_right",
    "bottom_left", "bottom_center", "bottom_right",
  ]),
  plot: new Set(["style_line", "style_stepline", "style_histogram", "style_cross", "style_area", "style_columns", "style_circles", "style_linebr"]),
};

// Métodos de array soportados (nombre → nº de argumentos, contando el id).
const ARRAY_FUNCTIONS: Record<string, number> = {
  new_float: 0,
  new_int: 0,
  new_bool: 0,
  new_string: 0,
  new_box: 0,
  new_line: 0,
  new_label: 0,
  new_color: 0,
  push: 2,
  unshift: 2,
  shift: 1,
  pop: 1,
  size: 1,
  get: 2,
  set: 3,
  remove: 2,
  insert: 3,
  clear: 1,
  first: 1,
  last: 1,
};

// Dibujos: box.* y line.* (nombre → nº de argumentos posicionales). new admite
// extra por named args (bgcolor, border_color, style, …); el resto exige aridad.
const BOX_FUNCTIONS: Record<string, number> = {
  new: 4,
  set_top: 2,
  set_bottom: 2,
  set_left: 2,
  set_right: 2,
  set_bgcolor: 2,
  set_border_color: 2,
  set_border_width: 2,
  set_lefttop: 3,
  set_rightbottom: 3,
  delete: 1,
};
const LINE_FUNCTIONS: Record<string, number> = {
  new: 4,
  set_xy1: 3,
  set_xy2: 3,
  set_x1: 2,
  set_y1: 2,
  set_x2: 2,
  set_y2: 2,
  set_color: 2,
  set_width: 2,
  set_style: 2,
  delete: 1,
};
// label.* — new/set_* admiten extras por named (text, color, textcolor, size…).
const LABEL_FUNCTIONS: Record<string, number> = {
  new: 2,
  set_x: 2,
  set_y: 2,
  set_xy: 3,
  set_text: 2,
  set_color: 2,
  set_textcolor: 2,
  set_style: 2,
  set_size: 2,
  delete: 1,
};
// table.* — new(position, cols, rows) y cell(id, col, row, text) admiten named.
const TABLE_FUNCTIONS: Record<string, number> = {
  new: 3,
  cell: 4,
  set_cell_text: 4,
  clear: 3,
  delete: 1,
};
// Métodos que aceptan argumentos posicionales EXTRA vía named (no exigen aridad).
const FLEXIBLE_DRAW_METHODS = new Set(["new", "cell"]);

// Palabras de tipo en declaraciones Pine: `float x = ...`, `var int n = ...`.
// Se aceptan pero son informativas (el runtime es numérico); sirven para no
// rechazar scripts reales que las usan.
const TYPE_KEYWORDS = new Set([
  "int",
  "float",
  "bool",
  "color",
  "string",
  "line",
  "label",
  "box",
  "table",
  "array",
  "matrix",
  "map",
  "simple",
  "series",
  "const",
]);

class LineParser {
  private pos = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly line: number,
    private readonly nextSiteId: () => number,
  ) {}

  peek(): Token | null {
    return this.tokens[this.pos] ?? null;
  }

  peekAt(offset: number): Token | null {
    return this.tokens[this.pos + offset] ?? null;
  }

  atOp(value: string): boolean {
    const t = this.peek();
    return t != null && t.type === "op" && t.value === value;
  }

  take(): Token {
    const t = this.tokens[this.pos];
    if (!t) throw new PineError("Fin de línea inesperado", this.line);
    this.pos++;
    return t;
  }

  expectOp(value: string): void {
    const t = this.take();
    if (t.type !== "op" || t.value !== value) {
      throw new PineError(`Se esperaba '${value}' y llegó '${t.value}'`, this.line);
    }
  }

  atEnd(): boolean {
    return this.pos >= this.tokens.length;
  }

  parseExpr(minPrec = 0): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (!t || t.type !== "op") break;
      if (t.value === "?" && minPrec <= 1) {
        this.take();
        const thenE = this.parseExpr(0);
        this.expectOp(":");
        const elseE = this.parseExpr(1);
        left = { kind: "ternary", cond: left, then: thenE, else: elseE };
        continue;
      }
      const prec = binPrec(t.value);
      if (prec === 0 || prec < minPrec) break;
      this.take();
      const right = this.parseExpr(prec + 1);
      left = { kind: "bin", op: t.value, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t && t.type === "op" && (t.value === "-" || t.value === "not")) {
      this.take();
      return { kind: "unary", op: t.value as "-" | "not", expr: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let base = this.parsePrimary();
    for (;;) {
      if (this.atOp("[")) {
        this.take();
        const offset = this.parseExpr(0);
        this.expectOp("]");
        base = { kind: "index", base, offset, line: this.line };
        continue;
      }
      break;
    }
    return base;
  }

  private parsePrimary(): Expr {
    const t = this.take();
    if (t.type === "num") return { kind: "num", value: Number(t.value) };
    if (t.type === "str") return { kind: "str", value: t.value };
    // Literal de array: `["a", "b"]` (típico en `options=[…]` de los input.*).
    // Empezar una expresión con '[' es inequívoco: el indexado `x[1]` se maneja
    // en parsePostfix, que exige una base a la izquierda.
    if (t.type === "op" && t.value === "[") {
      const items: Expr[] = [];
      if (!this.atOp("]")) {
        for (;;) {
          items.push(this.parseExpr(0));
          if (this.atOp(",")) {
            this.take();
            continue;
          }
          break;
        }
      }
      this.expectOp("]");
      return { kind: "arraylit", items, line: this.line };
    }
    if (t.type === "op" && t.value === "(") {
      const e = this.parseExpr(0);
      this.expectOp(")");
      return e;
    }
    if (t.type === "ident") {
      // ¿miembro de namespace? ta.ema / color.red / strategy.long / math.abs
      if (this.atOp(".")) {
        if (!NAMESPACES.has(t.value)) {
          throw new PineError(`Namespace desconocido '${t.value}.' (soportados: ta, math, color, input, strategy)`, this.line);
        }
        this.take();
        const member = this.take();
        if (member.type !== "ident") throw new PineError(`Miembro inválido tras '${t.value}.'`, this.line);
        if (this.atOp("(")) {
          return this.parseCall(t.value, member.value);
        }
        return { kind: "member", ns: t.value, name: member.value, line: this.line };
      }
      if (this.atOp("(")) {
        return this.parseCall(null, t.value);
      }
      return { kind: "ident", name: t.value, line: this.line };
    }
    throw new PineError(`Token inesperado '${t.value}'`, this.line);
  }

  parseCall(ns: string | null, name: string): Expr {
    this.expectOp("(");
    const args: Expr[] = [];
    const named: Record<string, Expr> = {};
    if (!this.atOp(")")) {
      for (;;) {
        // ¿argumento nombrado? ident '=' (pero no '==')
        const t = this.peek();
        const t2 = this.peekAt(1);
        if (t && t.type === "ident" && t2 && t2.type === "op" && t2.value === "=") {
          this.take();
          this.take();
          named[t.value] = this.parseExpr(0);
        } else {
          if (Object.keys(named).length > 0) {
            throw new PineError("Argumentos posicionales no pueden ir después de nombrados", this.line);
          }
          args.push(this.parseExpr(0));
        }
        if (this.atOp(",")) {
          this.take();
          continue;
        }
        break;
      }
    }
    this.expectOp(")");
    return { kind: "call", ns, name, args, named, siteId: this.nextSiteId(), line: this.line };
  }
}

function binPrec(op: string): number {
  switch (op) {
    case "or":
      return 2;
    case "and":
      return 3;
    case "==":
    case "!=":
      return 4;
    case "<":
    case ">":
    case "<=":
    case ">=":
      return 5;
    case "+":
    case "-":
      return 6;
    case "*":
    case "/":
    case "%":
      return 7;
    default:
      return 0;
  }
}

// ── Constantes / helpers de args ─────────────────────────────────────────────

function constNumber(e: Expr, what: string, line: number): number {
  if (e.kind === "num") return e.value;
  if (e.kind === "unary" && e.op === "-" && e.expr.kind === "num") return -e.expr.value;
  throw new PineError(`${what} debe ser un número literal`, line);
}

function constString(e: Expr, what: string, line: number): string {
  if (e.kind === "str") return e.value;
  throw new PineError(`${what} debe ser un string literal`, line);
}

function constBool(e: Expr, what: string, line: number): boolean {
  if (e.kind === "ident" && (e.name === "true" || e.name === "false")) return e.name === "true";
  throw new PineError(`${what} debe ser true o false`, line);
}

// ── Transformación input.* → literal (defaults; panel de inputs = fase 3) ───

function resolveInputs(e: Expr): Expr {
  switch (e.kind) {
    case "call": {
      if (e.ns === "input") {
        const dflt = e.args[0];
        if (!dflt) throw new PineError(`input.${e.name}() necesita el valor por defecto`, e.line);
        // El input se reemplaza por su valor por defecto (aún no hay panel de inputs).
        switch (e.name) {
          case "bool":
            return { kind: "num", value: constBool(dflt, "input.bool", e.line) ? 1 : 0 };
          case "int":
          case "float":
            return { kind: "num", value: constNumber(dflt, `input.${e.name}`, e.line) };
          case "session":
          case "string":
          case "symbol":
          case "text_area":
          case "timeframe":
            if (dflt.kind !== "str") throw new PineError(`input.${e.name}() necesita un texto por defecto`, e.line);
            return { kind: "str", value: dflt.value };
          case "source":
            // El default ES la serie (hlc3, close…): el input se sustituye por ella.
            return resolveInputs(dflt);
          case "color":
            // El default es un color (color.new(...), color.lime, #RRGGBB).
            return resolveInputs(dflt);
          default:
            throw new PineError(`input.${e.name} no soportado (int, float, bool, string, session, timeframe, source, color)`, e.line);
        }
      }
      return {
        ...e,
        args: e.args.map(resolveInputs),
        named: Object.fromEntries(Object.entries(e.named).map(([k, v]) => [k, resolveInputs(v)])),
      };
    }
    case "index":
      return { ...e, base: resolveInputs(e.base), offset: resolveInputs(e.offset) };
    case "arraylit":
      return { ...e, items: e.items.map(resolveInputs) };
    case "unary":
      return { ...e, expr: resolveInputs(e.expr) };
    case "bin":
      return { ...e, left: resolveInputs(e.left), right: resolveInputs(e.right) };
    case "ternary":
      return { ...e, cond: resolveInputs(e.cond), then: resolveInputs(e.then), else: resolveInputs(e.else) };
    default:
      return e;
  }
}

// ── Programa (bloques por indentación) ───────────────────────────────────────

interface SrcLine {
  indent: number;
  tokens: Token[];
  lineNo: number;
}

// Balance de paréntesis/corchetes de una línea (+1 abre, −1 cierra). Sirve para
// detectar continuación implícita de una llamada partida en varias líneas.
function bracketDelta(tokens: Token[]): number {
  let d = 0;
  for (const t of tokens) {
    if (t.type !== "op") continue;
    if (t.value === "(" || t.value === "[") d++;
    else if (t.value === ")" || t.value === "]") d--;
  }
  return d;
}

/** Operadores que no pueden terminar una expresión: si la línea acaba en uno,
 *  Pine continúa en la siguiente (ternarios `? …  :` partidos, sumas colgando…). */
const DANGLING_OPS = new Set([
  "?", ":", "+", "-", "*", "/", "%", "and", "or", "not",
  "==", "!=", ">=", "<=", ">", "<", ",", "=", ":=",
]);

function endsDangling(tokens: Token[]): boolean {
  const last = tokens[tokens.length - 1];
  return !!last && last.type === "op" && DANGLING_OPS.has(last.value);
}

export function parsePine(source: string): PineProgram {
  // Estado por compilación (el módulo se reutiliza entre scripts).
  constColorVars = new Map();
  plotHandleVars = new Set();
  let siteCounter = 0;
  const nextSiteId = () => ++siteCounter;

  let title = "Kai Pine";
  let overlay = true;
  let isStrategy = false;
  let initialCapital = 10_000;
  let declSeen = false;

  const rawLines = source.split(/\r?\n/);
  const src: SrcLine[] = [];
  for (let idx = 0; idx < rawLines.length; idx++) {
    const lineNo = idx + 1;
    const raw = rawLines[idx];
    const tokens = tokenizeLine(raw, lineNo);
    if (tokens.length === 0) continue;
    const indent = /^[\t ]*/.exec(raw)![0].replace(/\t/g, "    ").length;
    // Continuación implícita: si la línea deja paréntesis/corchetes abiertos
    // (p. ej. una llamada box.new(...) partida en varias líneas), fusiona las
    // siguientes líneas físicas hasta cerrar, como TradingView/Python. El
    // statement conserva indent y lineNo de la PRIMERA línea.
    let depth = bracketDelta(tokens);
    while ((depth > 0 || endsDangling(tokens)) && idx + 1 < rawLines.length) {
      // Sin paréntesis abiertos, solo continúa si la siguiente línea trae algo
      // (evita tragarse líneas en blanco o comentarios sueltos).
      if (depth <= 0) {
        const peek = tokenizeLine(rawLines[idx + 1], idx + 2);
        if (peek.length === 0) break;
      }
      idx++;
      const cont = tokenizeLine(rawLines[idx], idx + 1);
      tokens.push(...cont);
      depth += bracketDelta(cont);
    }
    src.push({ indent, tokens, lineNo });
  }

  const definedVars = new Set<string>();
  // Funciones definidas por el usuario (nombre → firma). Se comparte con
  // validateExpr vía currentUserFuncs para validar sus llamadas.
  const userFuncs = new Map<string, { params: { name: string; default: Expr | null }[] }>();
  currentUserFuncs = userFuncs;

  // Parse recursivo de un bloque: consume líneas con indent >= blockIndent
  // (las de MAYOR indent pertenecen a sub-bloques de un if anterior).
  function parseBlock(pos: { i: number }, blockIndent: number, topLevel: boolean): Stmt[] {
    const out: Stmt[] = [];
    while (pos.i < src.length) {
      const line = src[pos.i];
      if (line.indent < blockIndent) break;
      if (line.indent > blockIndent) {
        throw new PineError("Indentación inesperada (¿sobra un espacio?)", line.lineNo);
      }
      const stmt = parseStatement(pos, blockIndent, topLevel);
      if (stmt) out.push(stmt);
    }
    return out;
  }

  function parseStatement(pos: { i: number }, blockIndent: number, topLevel: boolean): Stmt | null {
    const { tokens, lineNo } = src[pos.i];
    const p = new LineParser(tokens, lineNo, nextSiteId);
    const first = tokens[0];
    const second = tokens[1];
    pos.i++;

    // indicator("...") / strategy("...") — solo top-level, define el tipo.
    if (
      topLevel &&
      first.type === "ident" &&
      (first.value === "indicator" || first.value === "strategy") &&
      second?.type === "op" &&
      second.value === "("
    ) {
      if (declSeen) throw new PineError("indicator()/strategy() solo puede declararse una vez", lineNo);
      declSeen = true;
      p.take();
      const call = p.parseCall(null, first.value);
      if (call.kind !== "call") throw new PineError(`${first.value}() inválido`, lineNo);
      // El título puede venir nombrado (`title=`/`shorttitle=`) o como primer
      // argumento posicional. En TradingView es el NOMBRE del indicador.
      if (call.named.title) title = constString(call.named.title, "title", lineNo);
      else if (call.named.shorttitle) title = constString(call.named.shorttitle, "shorttitle", lineNo);
      else if (call.args[0]) title = constString(call.args[0], "El título", lineNo);
      if (call.named.overlay) overlay = constBool(call.named.overlay, "overlay", lineNo);
      if (first.value === "strategy") {
        isStrategy = true;
        if (call.named.initial_capital) {
          initialCapital = constNumber(call.named.initial_capital, "initial_capital", lineNo);
        }
      }
      if (!p.atEnd()) throw new PineError(`Contenido extra tras ${first.value}()`, lineNo);
      return null;
    }

    // Desestructuración de tupla: `[a, b, c] = ta.macd(...)`. Única construcción
    // Pine que empieza una sentencia con '[' (antes esto daba "Token inesperado '['").
    if (first.type === "op" && first.value === "[") {
      p.take(); // '['
      const names: string[] = [];
      for (;;) {
        const nt = p.take();
        if (nt.type !== "ident") {
          throw new PineError("La desestructuración '[a, b, c] = …' solo admite nombres de variable", lineNo);
        }
        if (BUILTIN_SERIES.has(nt.value)) {
          throw new PineError(`No puedes desestructurar sobre la serie integrada '${nt.value}'`, lineNo);
        }
        names.push(nt.value);
        if (p.atOp(",")) {
          p.take();
          continue;
        }
        break;
      }
      p.expectOp("]");
      const eqTok = p.take();
      if (eqTok.type !== "op" || eqTok.value !== "=") {
        throw new PineError("La desestructuración necesita '=' (p. ej. [macdLine, signalLine, histLine] = ta.macd(close, 12, 26, 9))", lineNo);
      }
      const rhs = resolveInputs(p.parseExpr(0));
      if (!p.atEnd()) throw new PineError("Contenido extra tras la desestructuración", lineNo);
      if (rhs.kind !== "call" || rhs.ns !== "ta" || !(rhs.name in TA_TUPLE_FUNCTIONS)) {
        throw new PineError("La desestructuración '[…] = …' solo soporta funciones multi-retorno: ta.macd, ta.bb, ta.dmi", lineNo);
      }
      const spec = TA_TUPLE_FUNCTIONS[rhs.name];
      if (rhs.args.length !== spec.args) {
        throw new PineError(`ta.${rhs.name}() espera ${spec.args} argumento(s) y recibió ${rhs.args.length}`, lineNo);
      }
      if (names.length !== spec.returns) {
        throw new PineError(`ta.${rhs.name}() devuelve ${spec.returns} valores pero desestructuras ${names.length}`, lineNo);
      }
      // Valida los ARGUMENTOS (no el call entero: ta.macd/bb/dmi no están en
      // TA_FUNCTIONS, así que validateExpr sobre el call lanzaría "desconocida").
      for (const a of rhs.args) validateExpr(a, definedVars, lineNo);
      for (const nm of names) definedVars.add(nm);
      return { kind: "destructure", names, expr: rhs, line: lineNo };
    }

    // if cond  →  bloque indentado; opcional `else` / `else if` al mismo nivel.
    if (first.type === "ident" && first.value === "if") {
      // Recursivo para soportar cadenas `else if` (se anidan como if en el else).
      const parseIf = (ifTokens: Token[], ifLineNo: number): Stmt => {
        const ip = new LineParser(ifTokens, ifLineNo, nextSiteId);
        ip.take(); // 'if'
        const cond = resolveInputs(ip.parseExpr(0));
        validateExpr(cond, definedVars, ifLineNo);
        if (!ip.atEnd()) {
          throw new PineError("Contenido extra tras la condición del if (el cuerpo va indentado en las líneas siguientes)", ifLineNo);
        }
        const bodyIndent = src[pos.i]?.indent ?? -1;
        if (pos.i >= src.length || bodyIndent <= blockIndent) {
          throw new PineError("El if necesita un cuerpo indentado en la línea siguiente", ifLineNo);
        }
        const thenStmts = parseBlock(pos, bodyIndent, false);
        let elseStmts: Stmt[] | null = null;
        const next = src[pos.i];
        if (next && next.indent === blockIndent && next.tokens[0]?.type === "ident" && next.tokens[0].value === "else") {
          const isElseIf = next.tokens[1]?.type === "ident" && next.tokens[1].value === "if";
          if (isElseIf) {
            // `else if cond`: anida un if completo en el else, con la misma indentación.
            pos.i++;
            elseStmts = [parseIf(next.tokens.slice(1), next.lineNo)];
          } else {
            if (next.tokens.length > 1) throw new PineError("'else' va solo en su línea (cuerpo indentado debajo)", next.lineNo);
            pos.i++;
            const elseIndent = src[pos.i]?.indent ?? -1;
            if (pos.i >= src.length || elseIndent <= blockIndent) {
              throw new PineError("El else necesita un cuerpo indentado en la línea siguiente", next.lineNo);
            }
            elseStmts = parseBlock(pos, elseIndent, false);
          }
        }
        return { kind: "if", cond, then: thenStmts, else: elseStmts, line: ifLineNo };
      };
      return parseIf(tokens, lineNo);
    }

    // strategy.entry / strategy.close / strategy.exit
    if (
      first.type === "ident" &&
      first.value === "strategy" &&
      second?.type === "op" &&
      second.value === "."
    ) {
      p.take();
      p.take();
      const methodTok = p.take();
      if (methodTok.type !== "ident" || !["entry", "close", "exit"].includes(methodTok.value)) {
        throw new PineError(`strategy.${methodTok.value} no soportado (entry, close, exit)`, lineNo);
      }
      const method = methodTok.value as StrategyMethod;
      const call = p.parseCall("strategy", method);
      if (call.kind !== "call") throw new PineError("llamada inválida", lineNo);
      if (!p.atEnd()) throw new PineError(`Contenido extra tras strategy.${method}()`, lineNo);
      let direction: Expr | null = null;
      let stop: Expr | null = null;
      let limit: Expr | null = null;
      if (method === "entry") {
        // strategy.entry("id", strategy.long|strategy.short)
        const dir = call.args[1] ?? null;
        if (!dir) throw new PineError('strategy.entry("id", strategy.long | strategy.short)', lineNo);
        direction = resolveInputs(dir);
        validateExpr(direction, definedVars, lineNo);
      } else if (method === "exit") {
        stop = call.named.stop ? resolveInputs(call.named.stop) : null;
        limit = call.named.limit ? resolveInputs(call.named.limit) : null;
        if (!stop && !limit) throw new PineError("strategy.exit necesita stop= y/o limit=", lineNo);
        if (stop) validateExpr(stop, definedVars, lineNo);
        if (limit) validateExpr(limit, definedVars, lineNo);
      }
      return { kind: "strategy", method, direction, stop, limit, line: lineNo };
    }

    // for i = inicio to fin [by paso]  →  bucle acotado con cuerpo indentado.
    if (first.type === "ident" && first.value === "for") {
      p.take();
      const nameTok = p.take();
      if (nameTok.type !== "ident") throw new PineError("for necesita 'for i = inicio to fin'", lineNo);
      const loopVar = nameTok.value;
      if (BUILTIN_SERIES.has(loopVar)) throw new PineError(`No puedes usar la serie integrada '${loopVar}' como variable del for`, lineNo);
      const eqTok = p.take();
      if (eqTok.type !== "op" || eqTok.value !== "=") throw new PineError("for necesita 'for i = inicio to fin'", lineNo);
      const fromE = resolveInputs(p.parseExpr(0));
      const toTok = p.take();
      if (toTok.type !== "ident" || toTok.value !== "to") throw new PineError("for usa 'to': for i = 0 to 10", lineNo);
      const toE = resolveInputs(p.parseExpr(0));
      let stepE: Expr | null = null;
      if (!p.atEnd()) {
        const byTok = p.take();
        if (byTok.type !== "ident" || byTok.value !== "by") throw new PineError("tras el límite del for solo va 'by <paso>'", lineNo);
        stepE = resolveInputs(p.parseExpr(0));
      }
      if (!p.atEnd()) throw new PineError("Contenido extra en la cabecera del for", lineNo);
      // La variable de bucle es visible dentro del cuerpo.
      definedVars.add(loopVar);
      validateExpr(fromE, definedVars, lineNo);
      validateExpr(toE, definedVars, lineNo);
      if (stepE) validateExpr(stepE, definedVars, lineNo);
      const bodyIndent = src[pos.i]?.indent ?? -1;
      if (pos.i >= src.length || bodyIndent <= blockIndent) {
        throw new PineError("El for necesita un cuerpo indentado en la línea siguiente", lineNo);
      }
      const body = parseBlock(pos, bodyIndent, false);
      return { kind: "for", varName: loopVar, from: fromE, to: toE, step: stepE, body, line: lineNo };
    }

    // while cond  →  bucle con cuerpo indentado (con guardia anti-infinito en runtime).
    if (first.type === "ident" && first.value === "while") {
      p.take();
      const cond = resolveInputs(p.parseExpr(0));
      if (!p.atEnd()) throw new PineError("Contenido extra tras la condición del while", lineNo);
      validateExpr(cond, definedVars, lineNo);
      const bodyIndent = src[pos.i]?.indent ?? -1;
      if (pos.i >= src.length || bodyIndent <= blockIndent) {
        throw new PineError("El while necesita un cuerpo indentado en la línea siguiente", lineNo);
      }
      const body = parseBlock(pos, bodyIndent, false);
      return { kind: "while", cond, body, line: lineNo };
    }

    // Definición de función de usuario:  nombre(p1, tipo p2, p3=def) => cuerpo
    // Cuerpo en una línea (tras =>) o bloque indentado; el valor de la última
    // sentencia-expresión del bloque es el retorno.
    if (
      first.type === "ident" &&
      second?.type === "op" &&
      second.value === "(" &&
      tokens.some((t) => t.type === "op" && t.value === "=>")
    ) {
      const name = first.value;
      if (BUILTIN_SERIES.has(name) || NAMESPACES.has(name)) {
        throw new PineError(`No puedes definir una función con el nombre reservado '${name}'`, lineNo);
      }
      p.take(); // nombre
      p.expectOp("(");
      const params: { name: string; default: Expr | null }[] = [];
      if (!p.atOp(")")) {
        for (;;) {
          // tipo opcional delante del parámetro: `float entry`, `bool isLong`
          const t0 = p.peek();
          const t1 = p.peekAt(1);
          if (t0?.type === "ident" && TYPE_KEYWORDS.has(t0.value) && t1?.type === "ident") p.take();
          const pname = p.take();
          if (pname.type !== "ident") throw new PineError("parámetro inválido en la definición de función", lineNo);
          let def: Expr | null = null;
          if (p.atOp("=")) {
            p.take();
            def = resolveInputs(p.parseExpr(0));
          }
          params.push({ name: pname.value, default: def });
          if (p.atOp(",")) {
            p.take();
            continue;
          }
          break;
        }
      }
      p.expectOp(")");
      p.expectOp("=>");

      // Registrar antes de parsear el cuerpo (permite recursión).
      userFuncs.set(name, { params });

      // Parámetros visibles como variables SOLO dentro del cuerpo.
      const before = new Set(definedVars);
      for (const pr of params) definedVars.add(pr.name);

      let body: Stmt[];
      if (!p.atEnd()) {
        // Cuerpo en una línea: es la expresión de retorno.
        const retExpr = resolveInputs(p.parseExpr(0));
        if (!p.atEnd()) throw new PineError("Contenido extra tras el cuerpo de la función", lineNo);
        validateExpr(retExpr, definedVars, lineNo);
        body = [{ kind: "exprstmt", expr: retExpr, line: lineNo }];
      } else {
        const bodyIndent = src[pos.i]?.indent ?? -1;
        if (pos.i >= src.length || bodyIndent <= blockIndent) {
          throw new PineError(
            "La función necesita un cuerpo: una expresión tras '=>' en la misma línea, o un bloque indentado debajo",
            lineNo,
          );
        }
        body = parseBlock(pos, bodyIndent, false);
      }

      // Restaurar: quitar de definedVars todo lo añadido dentro del cuerpo.
      for (const v of Array.from(definedVars)) if (!before.has(v)) definedVars.delete(v);

      return { kind: "funcdef", name, params, body, line: lineNo };
    }

    // Declaración/asignación:  [var|varip] [tipo] nombre = expr   |   nombre := expr
    // Detecta un prefijo opcional `var`/`varip` y/o una palabra de tipo
    // (float, int, bool, color, string, …) antes del `nombre = ...`.
    {
      const isVarKw = first.type === "ident" && (first.value === "var" || first.value === "varip");
      const afterVar = isVarKw ? 1 : 0;
      const typeTok = tokens[afterVar];
      const hasType = !!(typeTok && typeTok.type === "ident" && TYPE_KEYWORDS.has(typeTok.value));
      // Sufijo de array en el tipo:  var box[] posBoxes = array.new_box()
      // Tras la palabra de tipo, un par `[` `]` declara un array de ese tipo.
      const afterTypeIdx = afterVar + (hasType ? 1 : 0);
      const hasArraySuffix =
        hasType && tokens[afterTypeIdx]?.type === "op" && tokens[afterTypeIdx].value === "[" &&
        tokens[afterTypeIdx + 1]?.type === "op" && tokens[afterTypeIdx + 1].value === "]";
      const nameIdx = afterTypeIdx + (hasArraySuffix ? 2 : 0);
      const nameTok = tokens[nameIdx];
      const opTok = tokens[nameIdx + 1];
      const isDecl =
        (isVarKw || hasType) &&
        nameTok?.type === "ident" &&
        opTok?.type === "op" &&
        (opTok.value === "=" || opTok.value === ":=" || opTok.value in COMPOUND_ASSIGN);
      // Asignación simple sin prefijo: nombre = expr | nombre := expr
      const isPlain =
        !isVarKw && !hasType && first.type === "ident" && second?.type === "op" &&
        (second.value === "=" || second.value === ":=" || second.value in COMPOUND_ASSIGN);
      if (isDecl || isPlain) {
        const name = isPlain ? first.value : nameTok!.value;
        const op = isPlain ? second!.value : opTok!.value;
        if (BUILTIN_SERIES.has(name)) throw new PineError(`No puedes reasignar la serie integrada '${name}'`, lineNo);
        // Consumir prefijos + nombre + operador.
        const consumeBeforeName = isPlain ? 0 : nameIdx;
        for (let k = 0; k < consumeBeforeName; k++) p.take();
        p.take(); // nombre
        p.take(); // '=' o ':='
        const expr = resolveInputs(p.parseExpr(0));
        if (!p.atEnd()) throw new PineError("Contenido extra tras la expresión", lineNo);
        // `p1 = plot(serie, …)`: en Pine el plot devuelve un handle que luego usa
        // fill(p1, p2). Emitimos el plot y damos a la variable un id numérico
        // (el relleno no se pinta, pero ambas series sí y el script compila).
        if (expr.kind === "call" && expr.ns === null && expr.name === "plot" && op === "=") {
          if (!topLevel) throw new PineError("plot() solo puede ir en el nivel superior (no dentro de un if)", lineNo);
          if (expr.args.length < 1) throw new PineError("plot() necesita al menos 1 argumento", lineNo);
          const mainArg = resolveInputs(expr.args[0]);
          validateExpr(mainArg, definedVars, lineNo);
          const colorExpr = expr.named.color ?? null;
          if (colorExpr) validateColorExpr(colorExpr, lineNo);
          const titleArg = expr.named.title ? constString(expr.named.title, "title", lineNo) : null;
          const lw = expr.named.linewidth ? constNumber(expr.named.linewidth, "linewidth", lineNo) : 1;
          definedVars.add(name);
          plotHandleVars.add(name);
          return { kind: "plot", expr: mainArg, color: colorExpr, title: titleArg, linewidth: lw, line: lineNo };
        }
        validateExpr(expr, definedVars, lineNo);
        // ¿La variable guarda un color constante? (para `color.new(c, 40)` y `color=c`)
        if (isColorExpr(expr)) constColorVars.set(name, expr);
        if (op in COMPOUND_ASSIGN) {
          if (isVarKw || hasType) {
            throw new PineError(`'${op}' modifica una variable existente; no lleva 'var' ni tipo delante`, lineNo);
          }
          if (!definedVars.has(name)) {
            throw new PineError(`'${op}' modifica una variable existente y '${name}' no está definida`, lineNo);
          }
          return {
            kind: "reassign",
            name,
            expr: { kind: "bin", op: COMPOUND_ASSIGN[op], left: { kind: "ident", name, line: lineNo }, right: expr },
            line: lineNo,
          };
        }
        if (op === ":=") {
          if (isVarKw || hasType) {
            throw new PineError("':=' reasigna; no lleva 'var' ni tipo delante (usa '=' para declarar)", lineNo);
          }
          if (!definedVars.has(name)) {
            throw new PineError(`':=' reasigna una variable existente y '${name}' no está definida (usa '=' primero)`, lineNo);
          }
          return { kind: "reassign", name, expr, line: lineNo };
        }
        definedVars.add(name);
        return { kind: "assign", name, expr, isVar: isVarKw, line: lineNo };
      }
    }

    // plot(...) / hline(...) — solo top-level (igual que Pine).
    if (first.type === "ident" && (first.value === "plot" || first.value === "hline") && second?.type === "op" && second.value === "(") {
      if (!topLevel) throw new PineError(`${first.value}() solo puede ir en el nivel superior (no dentro de un if)`, lineNo);
      p.take();
      const call = p.parseCall(null, first.value);
      if (call.kind !== "call") throw new PineError("llamada inválida", lineNo);
      if (!p.atEnd()) throw new PineError(`Contenido extra tras ${first.value}()`, lineNo);
      if (call.args.length < 1) throw new PineError(`${first.value}() necesita al menos 1 argumento`, lineNo);
      const mainArg = resolveInputs(call.args[0]);
      validateExpr(mainArg, definedVars, lineNo);
      const colorExpr = call.named.color ?? null;
      if (colorExpr) validateColorExpr(colorExpr, lineNo);
      const titleArg = call.named.title ? constString(call.named.title, "title", lineNo) : null;
      if (first.value === "plot") {
        const lw = call.named.linewidth ? constNumber(call.named.linewidth, "linewidth", lineNo) : 1;
        return { kind: "plot", expr: mainArg, color: colorExpr, title: titleArg, linewidth: lw, line: lineNo };
      }
      return { kind: "hline", value: mainArg, color: colorExpr, title: titleArg, line: lineNo };
    }

    // Sentencia-expresión: llamada con efectos secundarios o expresión suelta
    // (p. ej. el retorno en la última línea del cuerpo de una función). Se
    // valida como cualquier expresión; si la construcción no existe, el propio
    // validateExpr da el error preciso.
    const stmtExpr = resolveInputs(p.parseExpr(0));
    if (!p.atEnd()) throw new PineError("Contenido extra tras la expresión", lineNo);
    validateExpr(stmtExpr, definedVars, lineNo);
    return { kind: "exprstmt", expr: stmtExpr, line: lineNo };
  }

  const pos = { i: 0 };
  const statements = parseBlock(pos, 0, true);
  if (pos.i < src.length) {
    throw new PineError("Indentación inválida", src[pos.i].lineNo);
  }

  const hasOutput =
    statements.some((s) => s.kind === "plot" || s.kind === "hline") ||
    (isStrategy && hasStrategyCall(statements));
  if (!hasOutput) {
    throw new PineError("El script no tiene plot(), hline() ni órdenes de estrategia: no habría nada que mostrar", rawLines.length || 1);
  }

  return { title, overlay, isStrategy, initialCapital, statements };
}

function hasStrategyCall(stmts: Stmt[]): boolean {
  return stmts.some(
    (s) => s.kind === "strategy" || (s.kind === "if" && (hasStrategyCall(s.then) || (s.else ? hasStrategyCall(s.else) : false))),
  );
}

// ── Validación semántica ligera ──────────────────────────────────────────────

export const BUILTIN_SERIES = new Set(["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"]);

export const TA_FUNCTIONS: Record<string, number> = {
  // nombre → nº de args posicionales esperados
  ema: 2,
  sma: 2,
  wma: 2,
  rsi: 2,
  atr: 1,
  stdev: 2,
  highest: 2,
  lowest: 2,
  change: 1,
  tr: 0,
  crossover: 2,
  crossunder: 2,
};

// Funciones ta.* multi-retorno: solo válidas como RHS de una desestructuración
// `[a, b, c] = ta.fn(...)`. args = nº de argumentos posicionales; returns = nº de
// valores devueltos (= nombres a la izquierda). NO están en TA_FUNCTIONS a
// propósito: usarlas como valor escalar (x = ta.macd(...)) debe seguir siendo error.
export const TA_TUPLE_FUNCTIONS: Record<string, { args: number; returns: number }> = {
  macd: { args: 4, returns: 3 }, // [macdLine, signalLine, histLine] = ta.macd(src, fast, slow, sig)
  bb: { args: 3, returns: 3 }, //   [middle, upper, lower]          = ta.bb(src, length, mult)
  dmi: { args: 2, returns: 3 }, //  [diPlus, diMinus, adx]          = ta.dmi(diLength, adxSmoothing)
};

export const MATH_FUNCTIONS = new Set(["abs", "max", "min", "round", "floor", "ceil", "sqrt", "pow", "log", "log10", "avg", "sign", "exp", "sum"]);

export const STRATEGY_MEMBERS = new Set(["long", "short", "position_size", "position_avg_price"]);

export const COLOR_CONSTANTS: Record<string, string> = {
  red: "#ef5350",
  green: "#2ed68d",
  blue: "#2962ff",
  orange: "#ff9800",
  yellow: "#fdd835",
  purple: "#ab47bc",
  aqua: "#00bcd4",
  teal: "#00897b",
  lime: "#cddc39",
  fuchsia: "#e040fb",
  white: "#ffffff",
  gray: "#9598a1",
  silver: "#c8c8c8",
  maroon: "#880e4f",
  navy: "#311b92",
  olive: "#808000",
  black: "#000000",
};

// Funciones de usuario visibles para validateExpr (set por parsePine, no
// reentrante: el parseo es síncrono y de un solo programa a la vez).
let currentUserFuncs = new Map<string, { params: { name: string; default: Expr | null }[] }>();
// Variables cuyo valor es un color CONSTANTE (`c = color.new(#089981, 0)`), para que
// `color.new(c, 40)` / `color=c` se resuelvan aunque el color venga por variable.
let constColorVars = new Map<string, Expr>();
/** Variables que guardan el handle de un plot (`p = plot(...)`), para fill(p1, p2). */
let plotHandleVars = new Set<string>();

/** ¿La expresión es un color constante (color.*, color.new/rgb, #hex o var de color)? */
function isColorExpr(e: Expr): boolean {
  if (e.kind === "str") return HEX_COLOR.test(e.value);
  if (e.kind === "member") return e.ns === "color";
  if (e.kind === "call") return e.ns === "color";
  if (e.kind === "ident") return constColorVars.has(e.name);
  return false;
}

function validateExpr(e: Expr, definedVars: Set<string>, line: number): void {
  switch (e.kind) {
    case "num":
    case "str":
      return;
    case "arraylit":
      for (const it of e.items) validateExpr(it, definedVars, line);
      return;
    case "ident":
      if (e.name === "true" || e.name === "false" || e.name === "na") return;
      if (BUILTIN_SERIES.has(e.name) || BUILTIN_VARS.has(e.name)) return;
      if (!definedVars.has(e.name)) {
        throw new PineError(`Variable '${e.name}' no definida (defínela antes de usarla)`, line);
      }
      return;
    case "member":
      if (e.ns === "color") {
        if (!(e.name in COLOR_CONSTANTS)) throw new PineError(`Color desconocido 'color.${e.name}'`, line);
        return;
      }
      if (e.ns === "strategy") {
        if (!STRATEGY_MEMBERS.has(e.name)) {
          throw new PineError(`'strategy.${e.name}' no soportado (long, short, position_size, position_avg_price)`, line);
        }
        return;
      }
      if (e.ns in MEMBER_NAMESPACES) {
        if (!MEMBER_NAMESPACES[e.ns].has(e.name)) {
          throw new PineError(`'${e.ns}.${e.name}' no soportado`, line);
        }
        return;
      }
      throw new PineError(`'${e.ns}.${e.name}' no es un valor (¿faltan paréntesis?)`, line);
    case "call": {
      // timeframe.change("D"/"W"/"M"): true en la 1ª barra de cada periodo.
      if (e.ns === "timeframe" && e.name === "change") {
        if (e.args.length !== 1) throw new PineError('timeframe.change("D") espera 1 argumento', line);
        validateExpr(e.args[0], definedVars, line);
        return;
      }
      if (e.ns === "ta") {
        if (!(e.name in TA_FUNCTIONS)) throw new PineError(`Función desconocida 'ta.${e.name}'`, line);
        const expected = TA_FUNCTIONS[e.name];
        // ta.tr acepta el flag opcional handle_na: ta.tr(true).
        if (e.name === "tr" && e.args.length <= 1) {
          for (const a of e.args) validateExpr(a, definedVars, line);
          return;
        }
        if (e.args.length !== expected) {
          throw new PineError(`ta.${e.name}() espera ${expected} argumento(s) y recibió ${e.args.length}`, line);
        }
      } else if (e.ns === "math") {
        if (!MATH_FUNCTIONS.has(e.name)) throw new PineError(`Función desconocida 'math.${e.name}'`, line);
      } else if (e.ns === "array") {
        if (!(e.name in ARRAY_FUNCTIONS)) throw new PineError(`Función desconocida 'array.${e.name}'`, line);
        // new_* admite 0-2 args (tamaño inicial, valor); el resto exige su aridad.
        if (!e.name.startsWith("new_")) {
          const expected = ARRAY_FUNCTIONS[e.name];
          if (e.args.length !== expected) {
            throw new PineError(`array.${e.name}() espera ${expected} argumento(s) y recibió ${e.args.length}`, line);
          }
        }
      } else if (e.ns === "color") {
        if (e.name !== "rgb" && e.name !== "new") throw new PineError(`Función desconocida 'color.${e.name}'`, line);
      } else if (e.ns === "box" || e.ns === "line" || e.ns === "label" || e.ns === "table") {
        const table =
          e.ns === "box" ? BOX_FUNCTIONS : e.ns === "line" ? LINE_FUNCTIONS : e.ns === "label" ? LABEL_FUNCTIONS : TABLE_FUNCTIONS;
        if (!(e.name in table)) throw new PineError(`Función desconocida '${e.ns}.${e.name}'`, line);
        // new/cell admiten argumentos posicionales extra vía named; el resto exige aridad.
        if (!FLEXIBLE_DRAW_METHODS.has(e.name) && e.args.length !== table[e.name]) {
          throw new PineError(`${e.ns}.${e.name}() espera ${table[e.name]} argumento(s) y recibió ${e.args.length}`, line);
        }
      } else if (e.ns === "str") {
        if (e.name !== "tostring" && e.name !== "format") throw new PineError(`Función desconocida 'str.${e.name}'`, line);
      } else if (e.ns === null && e.name in GLOBAL_FUNCTIONS) {
        const [lo, hi] = GLOBAL_FUNCTIONS[e.name];
        if (e.args.length < lo || e.args.length > hi) {
          const rng = lo === hi ? `${lo}` : `${lo}-${hi}`;
          throw new PineError(`${e.name}() espera ${rng} argumento(s) y recibió ${e.args.length}`, line);
        }
      } else if (e.ns === "strategy") {
        throw new PineError("strategy.* como llamada va en su propia línea (entry/close/exit)", line);
      } else if (e.ns === "input") {
        // resolveInputs debió reemplazarla; si llega aquí es un uso raro.
        throw new PineError("input.* solo puede usarse como valor directo (x = input.int(20))", line);
      } else if (currentUserFuncs.has(e.name)) {
        const spec = currentUserFuncs.get(e.name)!;
        const required = spec.params.filter((p) => p.default === null).length;
        if (e.args.length < required || e.args.length > spec.params.length) {
          const rng = required === spec.params.length ? `${required}` : `${required}-${spec.params.length}`;
          throw new PineError(`${e.name}() espera ${rng} argumento(s) y recibió ${e.args.length}`, line);
        }
      } else {
        throw new PineError(`Función desconocida '${e.name}' (soportadas: ta.*, math.*, color.rgb, input.*, o funciones que definas con '=>')`, line);
      }
      for (const a of e.args) validateExpr(a, definedVars, line);
      for (const a of Object.values(e.named)) validateExpr(a, definedVars, line);
      return;
    }
    case "index":
      validateExpr(e.base, definedVars, line);
      validateExpr(e.offset, definedVars, line);
      return;
    case "unary":
      validateExpr(e.expr, definedVars, line);
      return;
    case "bin":
      validateExpr(e.left, definedVars, line);
      validateExpr(e.right, definedVars, line);
      return;
    case "ternary":
      validateExpr(e.cond, definedVars, line);
      validateExpr(e.then, definedVars, line);
      validateExpr(e.else, definedVars, line);
      return;
  }
}

const HEX_COLOR = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Aplica alpha (0..1) a un color CSS (#hex o rgb()) → rgba(). */
function colorWithAlpha(css: string, alpha: number): string {
  let r = 0;
  let g = 0;
  let b = 0;
  if (css.startsWith("#")) {
    let hex = css.slice(1);
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    if (hex.length >= 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
  } else {
    const m = css.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) {
      r = +m[1];
      g = +m[2];
      b = +m[3];
    }
  }
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
}

/** Colores fase 1: constantes (color.red, color.rgb, o literal hex #RRGGBB). */
function validateColorExpr(e: Expr, line: number): void {
  // Variable que guarda un color constante: `c = color.new(#089981, 0)` → color=c
  if (e.kind === "ident" && constColorVars.has(e.name)) return;
  if (e.kind === "member" && e.ns === "color") {
    if (!(e.name in COLOR_CONSTANTS)) throw new PineError(`Color desconocido 'color.${e.name}'`, line);
    return;
  }
  if (e.kind === "call" && e.ns === "color" && e.name === "rgb") {
    if (e.args.length < 3 || e.args.length > 4) throw new PineError("color.rgb(r, g, b[, alpha])", line);
    for (const a of e.args) constNumber(a, "color.rgb: componente", line);
    return;
  }
  if (e.kind === "call" && e.ns === "color" && e.name === "new") {
    if (e.args.length !== 2) throw new PineError("color.new(color, transp)", line);
    validateColorExpr(e.args[0], line);
    constNumber(e.args[1], "color.new: transparencia", line);
    return;
  }
  if (e.kind === "str" && HEX_COLOR.test(e.value)) return;
  throw new PineError("El color debe ser constante: color.<nombre>, color.rgb(r,g,b), color.new(c, t) o #RRGGBB", line);
}

/** Evalúa un color constante ya validado → string CSS. */
export function evalColorExpr(e: Expr | null, fallback: string): string {
  if (!e) return fallback;
  if (e.kind === "ident") {
    const bound = constColorVars.get(e.name);
    return bound ? evalColorExpr(bound, fallback) : fallback;
  }
  if (e.kind === "str" && HEX_COLOR.test(e.value)) return e.value;
  if (e.kind === "member" && e.ns === "color") return COLOR_CONSTANTS[e.name] ?? fallback;
  if (e.kind === "call" && e.ns === "color" && e.name === "rgb") {
    const nums = e.args.map((a) => (a.kind === "num" ? a.value : a.kind === "unary" && a.expr.kind === "num" ? -a.expr.value : 0));
    const [r, g, b, a] = nums;
    return a != null ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`;
  }
  if (e.kind === "call" && e.ns === "color" && e.name === "new") {
    // color.new(base, transp): transp 0=opaco, 100=transparente → alpha CSS.
    const base = evalColorExpr(e.args[0], fallback);
    const t = e.args[1]?.kind === "num" ? e.args[1].value : 0;
    const alpha = Math.max(0, Math.min(1, 1 - t / 100));
    return colorWithAlpha(base, alpha);
  }
  return fallback;
}
