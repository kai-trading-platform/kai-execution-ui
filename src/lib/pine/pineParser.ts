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
  | { kind: "unary"; op: "-" | "not"; expr: Expr }
  | { kind: "bin"; op: string; left: Expr; right: Expr }
  | { kind: "ternary"; cond: Expr; then: Expr; else: Expr };

export type StrategyMethod = "entry" | "close" | "exit";

export type Stmt =
  | { kind: "assign"; name: string; expr: Expr; line: number }
  | { kind: "reassign"; name: string; expr: Expr; line: number }
  | { kind: "plot"; expr: Expr; color: Expr | null; title: string | null; linewidth: number; line: number }
  | { kind: "hline"; value: Expr; color: Expr | null; title: string | null; line: number }
  | { kind: "if"; cond: Expr; then: Stmt[]; else: Stmt[] | null; line: number }
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

const OPS = [":=", "==", "!=", ">=", "<=", "and", "or", "not", "?", ":", ">", "<", "+", "-", "*", "/", "%", "(", ")", "[", "]", ",", "=", "."];

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

const NAMESPACES = new Set(["ta", "math", "color", "input", "strategy"]);

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
        if (!["int", "float", "bool"].includes(e.name)) {
          throw new PineError(`input.${e.name} no soportado (int, float, bool)`, e.line);
        }
        const dflt = e.args[0];
        if (!dflt) throw new PineError(`input.${e.name}() necesita el valor por defecto`, e.line);
        if (e.name === "bool") return { kind: "num", value: constBool(dflt, "input.bool", e.line) ? 1 : 0 };
        return { kind: "num", value: constNumber(dflt, `input.${e.name}`, e.line) };
      }
      return {
        ...e,
        args: e.args.map(resolveInputs),
        named: Object.fromEntries(Object.entries(e.named).map(([k, v]) => [k, resolveInputs(v)])),
      };
    }
    case "index":
      return { ...e, base: resolveInputs(e.base), offset: resolveInputs(e.offset) };
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

export function parsePine(source: string): PineProgram {
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
    src.push({ indent, tokens, lineNo });
  }

  const definedVars = new Set<string>();

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
      if (call.args[0]) title = constString(call.args[0], "El título", lineNo);
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

    // if cond  →  bloque indentado; opcional `else` al mismo nivel.
    if (first.type === "ident" && first.value === "if") {
      p.take();
      const cond = resolveInputs(p.parseExpr(0));
      validateExpr(cond, definedVars, lineNo);
      if (!p.atEnd()) throw new PineError("Contenido extra tras la condición del if (el cuerpo va indentado en las líneas siguientes)", lineNo);
      const bodyIndent = src[pos.i]?.indent ?? -1;
      if (pos.i >= src.length || bodyIndent <= blockIndent) {
        throw new PineError("El if necesita un cuerpo indentado en la línea siguiente", lineNo);
      }
      const thenStmts = parseBlock(pos, bodyIndent, false);
      let elseStmts: Stmt[] | null = null;
      const next = src[pos.i];
      if (next && next.indent === blockIndent && next.tokens[0]?.type === "ident" && next.tokens[0].value === "else") {
        if (next.tokens.length > 1) throw new PineError("'else' va solo en su línea (cuerpo indentado debajo)", next.lineNo);
        pos.i++;
        const elseIndent = src[pos.i]?.indent ?? -1;
        if (pos.i >= src.length || elseIndent <= blockIndent) {
          throw new PineError("El else necesita un cuerpo indentado en la línea siguiente", next.lineNo);
        }
        elseStmts = parseBlock(pos, elseIndent, false);
      }
      return { kind: "if", cond, then: thenStmts, else: elseStmts, line: lineNo };
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

    // asignación (=) o reasignación (:=)
    if (first.type === "ident" && second?.type === "op" && (second.value === "=" || second.value === ":=")) {
      const name = first.value;
      if (BUILTIN_SERIES.has(name)) throw new PineError(`No puedes reasignar la serie integrada '${name}'`, lineNo);
      p.take();
      p.take();
      const expr = resolveInputs(p.parseExpr(0));
      if (!p.atEnd()) throw new PineError("Contenido extra tras la expresión", lineNo);
      validateExpr(expr, definedVars, lineNo);
      if (second.value === ":=") {
        if (!definedVars.has(name)) {
          throw new PineError(`':=' reasigna una variable existente y '${name}' no está definida (usa '=' primero)`, lineNo);
        }
        return { kind: "reassign", name, expr, line: lineNo };
      }
      definedVars.add(name);
      return { kind: "assign", name, expr, line: lineNo };
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

    throw new PineError(
      "Sentencia no soportada: asignaciones (x = ...), if/else, strategy.entry/close/exit, plot(...), hline(...), indicator(...) o strategy(...)",
      lineNo,
    );
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

export const MATH_FUNCTIONS = new Set(["abs", "max", "min", "round", "floor", "ceil", "sqrt", "pow", "log"]);

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
      if (e.ns === "strategy") {
        if (!STRATEGY_MEMBERS.has(e.name)) {
          throw new PineError(`'strategy.${e.name}' no soportado (long, short, position_size, position_avg_price)`, line);
        }
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
      } else if (e.ns === "strategy") {
        throw new PineError("strategy.* como llamada va en su propia línea (entry/close/exit)", line);
      } else if (e.ns === "input") {
        // resolveInputs debió reemplazarla; si llega aquí es un uso raro.
        throw new PineError("input.* solo puede usarse como valor directo (x = input.int(20))", line);
      } else {
        throw new PineError(`Función desconocida '${e.name}' (soportadas: ta.*, math.*, color.rgb, input.*)`, line);
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
