// Parser del subset Pine v5 de Kai (ver docs/specs/2026-07-20-kai-pine-editor-design.md).
// Sin dependencias: tokenizer a mano + Pratt parser. Los errores llevan línea
// 1-based para que la consola del editor los marque como TradingView.
//
// El subset es LINE-ORIENTED: cada sentencia vive en su propia línea
// (asignación, plot/hline, indicator). No hay if/for/funciones de usuario.

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
  | { kind: "unary"; op: "-" | "not"; expr: Expr }
  | { kind: "bin"; op: string; left: Expr; right: Expr }
  | { kind: "ternary"; cond: Expr; then: Expr; else: Expr };

export type Stmt =
  | { kind: "indicator"; title: string; overlay: boolean; line: number }
  | { kind: "assign"; name: string; expr: Expr; line: number }
  | { kind: "plot"; expr: Expr; color: Expr | null; title: string | null; linewidth: number; line: number }
  | { kind: "hline"; value: Expr; color: Expr | null; title: string | null; line: number };

export interface PineProgram {
  title: string;
  overlay: boolean;
  statements: Stmt[]; // solo assign/plot/hline, en orden
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

interface Token {
  type: "num" | "str" | "ident" | "op";
  value: string;
  col: number;
}

const OPS = ["==", "!=", ">=", "<=", "and", "or", "not", "?", ":", ">", "<", "+", "-", "*", "/", "%", "(", ")", "[", "]", ",", "=", "."];

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

const NAMESPACES = new Set(["ta", "math", "color", "input"]);

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
    if (t.type === "op" && t.value === "(") {
      const e = this.parseExpr(0);
      this.expectOp(")");
      return e;
    }
    if (t.type === "ident") {
      // ¿miembro de namespace? ta.ema / color.red / math.abs
      if (this.atOp(".")) {
        if (!NAMESPACES.has(t.value)) {
          throw new PineError(`Namespace desconocido '${t.value}.' (soportados: ta, math, color)`, this.line);
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
        const t2 = this.tokens[this.pos + 1];
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

// ── Programa ─────────────────────────────────────────────────────────────────

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

export function parsePine(source: string): PineProgram {
  let siteCounter = 0;
  const nextSiteId = () => ++siteCounter;

  let title = "Kai Pine";
  let overlay = true;
  const statements: Stmt[] = [];
  const definedVars = new Set<string>();

  const lines = source.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const raw = lines[idx];
    const tokens = tokenizeLine(raw, lineNo);
    if (tokens.length === 0) continue;

    const p = new LineParser(tokens, lineNo, nextSiteId);
    const first = tokens[0];
    const second = tokens[1];

    // indicator("Título", overlay=true)
    if (first.type === "ident" && first.value === "indicator" && second?.type === "op" && second.value === "(") {
      p.take(); // indicator
      const call = p.parseCall(null, "indicator");
      if (call.kind !== "call") throw new PineError("indicator() inválido", lineNo);
      if (call.args[0]) title = constString(call.args[0], "El título de indicator()", lineNo);
      if (call.named.overlay) overlay = constBool(call.named.overlay, "overlay", lineNo);
      if (!p.atEnd()) throw new PineError("Contenido extra tras indicator()", lineNo);
      continue;
    }

    // asignación: ident '=' expr  (el '=' pelado, no '==')
    if (first.type === "ident" && second?.type === "op" && second.value === "=") {
      const name = first.value;
      if (BUILTIN_SERIES.has(name)) throw new PineError(`No puedes reasignar la serie integrada '${name}'`, lineNo);
      p.take();
      p.take();
      const expr = p.parseExpr(0);
      if (!p.atEnd()) throw new PineError("Contenido extra tras la expresión", lineNo);
      validateExpr(expr, definedVars, lineNo);
      definedVars.add(name);
      statements.push({ kind: "assign", name, expr, line: lineNo });
      continue;
    }

    // plot(...) / hline(...)
    if (first.type === "ident" && (first.value === "plot" || first.value === "hline") && second?.type === "op" && second.value === "(") {
      p.take();
      const call = p.parseCall(null, first.value);
      if (call.kind !== "call") throw new PineError("llamada inválida", lineNo);
      if (!p.atEnd()) throw new PineError(`Contenido extra tras ${first.value}()`, lineNo);
      if (call.args.length < 1) throw new PineError(`${first.value}() necesita al menos 1 argumento`, lineNo);
      validateExpr(call.args[0], definedVars, lineNo);
      const colorExpr = call.named.color ?? null;
      if (colorExpr) validateColorExpr(colorExpr, lineNo);
      const titleArg = call.named.title ? constString(call.named.title, "title", lineNo) : null;
      if (first.value === "plot") {
        const lw = call.named.linewidth ? constNumber(call.named.linewidth, "linewidth", lineNo) : 1;
        statements.push({ kind: "plot", expr: call.args[0], color: colorExpr, title: titleArg, linewidth: lw, line: lineNo });
      } else {
        statements.push({ kind: "hline", value: call.args[0], color: colorExpr, title: titleArg, line: lineNo });
      }
      continue;
    }

    throw new PineError(
      "Sentencia no soportada: usa asignaciones (x = ...), plot(...), hline(...) o indicator(...)",
      lineNo,
    );
  }

  if (!statements.some((s) => s.kind === "plot" || s.kind === "hline")) {
    throw new PineError("El script no tiene plot() ni hline(): no habría nada que dibujar", lines.length || 1);
  }

  return { title, overlay, statements };
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

export const MATH_FUNCTIONS = new Set(["abs", "max", "min", "round", "floor", "ceil", "sqrt", "pow", "log"]);

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

function validateExpr(e: Expr, definedVars: Set<string>, line: number): void {
  switch (e.kind) {
    case "num":
    case "str":
      return;
    case "ident":
      if (e.name === "true" || e.name === "false" || e.name === "na") return;
      if (BUILTIN_SERIES.has(e.name)) return;
      if (!definedVars.has(e.name)) {
        throw new PineError(`Variable '${e.name}' no definida (defínela antes de usarla)`, line);
      }
      return;
    case "member":
      if (e.ns === "color") {
        if (!(e.name in COLOR_CONSTANTS)) throw new PineError(`Color desconocido 'color.${e.name}'`, line);
        return;
      }
      throw new PineError(`'${e.ns}.${e.name}' no es un valor (¿faltan paréntesis?)`, line);
    case "call": {
      if (e.ns === "ta") {
        if (!(e.name in TA_FUNCTIONS)) throw new PineError(`Función desconocida 'ta.${e.name}'`, line);
        const expected = TA_FUNCTIONS[e.name];
        if (e.args.length !== expected) {
          throw new PineError(`ta.${e.name}() espera ${expected} argumento(s) y recibió ${e.args.length}`, line);
        }
      } else if (e.ns === "math") {
        if (!MATH_FUNCTIONS.has(e.name)) throw new PineError(`Función desconocida 'math.${e.name}'`, line);
      } else if (e.ns === "color") {
        if (e.name !== "rgb") throw new PineError(`Función desconocida 'color.${e.name}'`, line);
      } else if (e.ns === "input") {
        throw new PineError("input.* llega en fase 2 — usa un número literal por ahora", line);
      } else {
        throw new PineError(`Función desconocida '${e.name}' (soportadas: ta.*, math.*, color.rgb)`, line);
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

/** Colores fase 1: constantes (color.red o color.rgb con literales). */
function validateColorExpr(e: Expr, line: number): void {
  if (e.kind === "member" && e.ns === "color") {
    if (!(e.name in COLOR_CONSTANTS)) throw new PineError(`Color desconocido 'color.${e.name}'`, line);
    return;
  }
  if (e.kind === "call" && e.ns === "color" && e.name === "rgb") {
    if (e.args.length < 3 || e.args.length > 4) throw new PineError("color.rgb(r, g, b[, alpha])", line);
    for (const a of e.args) constNumber(a, "color.rgb: componente", line);
    return;
  }
  throw new PineError("En fase 1 el color debe ser constante: color.<nombre> o color.rgb(r,g,b)", line);
}

/** Evalúa un color constante ya validado → string CSS. */
export function evalColorExpr(e: Expr | null, fallback: string): string {
  if (!e) return fallback;
  if (e.kind === "member" && e.ns === "color") return COLOR_CONSTANTS[e.name] ?? fallback;
  if (e.kind === "call" && e.ns === "color" && e.name === "rgb") {
    const nums = e.args.map((a) => (a.kind === "num" ? a.value : a.kind === "unary" && a.expr.kind === "num" ? -a.expr.value : 0));
    const [r, g, b, a] = nums;
    return a != null ? `rgba(${r},${g},${b},${a})` : `rgb(${r},${g},${b})`;
  }
  return fallback;
}
