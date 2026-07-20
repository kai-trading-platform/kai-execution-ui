// API pública del compilador Kai Pine: compilePine(source) devuelve todo lo que
// la UI necesita para registrar el indicador en klinecharts (figures + calc) o
// un error con línea para la consola del editor.

import { parsePine, PineError, Stmt, evalColorExpr } from "./pineParser";
import { runPine, PineBar, StrategyReport } from "./pineRuntime";

export interface CompiledFigure {
  key: string;
  title: string;
  color: string;
  linewidth: number;
  /** true = hline (línea punteada de nivel constante) */
  isLevel: boolean;
}

export interface CompiledPine {
  title: string;
  overlay: boolean;
  isStrategy: boolean;
  figures: CompiledFigure[];
  /** Serie por figura para una lista de velas (mismo orden que figures). */
  calc: (bars: PineBar[]) => Array<Record<string, number | null>>;
  /** Probador: corre el broker simulado sobre las velas (null si no es strategy). */
  runStrategy: (bars: PineBar[]) => StrategyReport | null;
}

export interface PineCompileError {
  message: string;
  line: number;
}

export type CompileResult = { ok: true; compiled: CompiledPine } | { ok: false; error: PineCompileError };

// Paleta por defecto cuando el script no especifica color (rota por plot).
const DEFAULT_COLORS = ["#2962ff", "#ff9800", "#ab47bc", "#2ed68d", "#ef5350", "#00bcd4"];

export function compilePine(source: string): CompileResult {
  let statements: Stmt[];
  let title: string;
  let overlay: boolean;
  let isStrategy: boolean;
  let initialCapital: number;
  try {
    const program = parsePine(source);
    statements = program.statements;
    title = program.title;
    overlay = program.overlay;
    isStrategy = program.isStrategy;
    initialCapital = program.initialCapital;
  } catch (err) {
    if (err instanceof PineError) {
      return { ok: false, error: { message: err.message, line: err.line } };
    }
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err), line: 1 } };
  }

  const outputs = statements.filter((s): s is Extract<Stmt, { kind: "plot" | "hline" }> => s.kind === "plot" || s.kind === "hline");

  const figures: CompiledFigure[] = outputs.map((s, idx) => ({
    key: `p${idx}`,
    title: s.title ?? (s.kind === "hline" ? `nivel ${idx + 1}` : `plot ${idx + 1}`),
    color: evalColorExpr(s.color, DEFAULT_COLORS[idx % DEFAULT_COLORS.length]),
    linewidth: s.kind === "plot" ? Math.max(1, Math.min(4, Math.round(s.linewidth))) : 1,
    isLevel: s.kind === "hline",
  }));

  const calc = (bars: PineBar[]): Array<Record<string, number | null>> => {
    const { series } = runPine(statements, bars, { isStrategy, initialCapital });
    return bars.map((_, i) => {
      const row: Record<string, number | null> = {};
      for (let f = 0; f < figures.length; f++) {
        row[figures[f].key] = series[f][i];
      }
      return row;
    });
  };

  const runStrategy = (bars: PineBar[]): StrategyReport | null => {
    if (!isStrategy) return null;
    return runPine(statements, bars, { isStrategy, initialCapital }).strategy;
  };

  // Smoke-run con 3 velas sintéticas: detecta errores de runtime (p. ej. length
  // inválido) en COMPILE-time para que salgan en la consola y no al aplicar.
  try {
    calc([
      { open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
      { open: 1.5, high: 2.5, low: 1, close: 2, volume: 12 },
      { open: 2, high: 3, low: 1.5, close: 2.5, volume: 9 },
    ]);
  } catch (err) {
    if (err instanceof PineError) {
      return { ok: false, error: { message: err.message, line: err.line } };
    }
    return { ok: false, error: { message: err instanceof Error ? err.message : String(err), line: 1 } };
  }

  return { ok: true, compiled: { title, overlay, isStrategy, figures, calc, runStrategy } };
}
