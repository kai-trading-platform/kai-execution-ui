import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Copy, LineChart, Pencil, Play, Plus, Save, Trash2, Waypoints, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/contexts/AuthContext";
import { compilePine } from "@/lib/pine/compilePine";
import type { StrategyReport } from "@/lib/pine/pineRuntime";
import { PINE_EXAMPLES } from "@/lib/pine/examples";
import { applyPineScript, isPineApplied, removePineScript } from "@/lib/pine/pineChart";
import { getActiveProChart } from "@/lib/chartPro/chartInstance";
import { loadScripts, newScriptId, saveScripts, type PineScript } from "@/lib/pine/pineStore";
import { SYSTEM_SCRIPTS, isCamaronZonesOn, setCamaronZonesOn, onCamaronZonesChange } from "@/lib/pine/systemScripts";

// Editor Kai Pine (pestaña PINE del panel inferior): lista de scripts +
// textarea con gutter de líneas + consola. Sin dependencias de editor: un
// <textarea> monoespaciado con números de línea sincronizados por scroll.

type ConsoleMsg = { tone: "ok" | "error" | "info"; text: string } | null;

// Cabecera estilo TradingView para un script en blanco (© del usuario logueado).
function blankTemplate(username: string): string {
  return `// Este código Kai Pine corre en tu terminal — sintaxis Pine v5 (subset).
// © ${username}

//@version=6
indicator("Mi script")
plot(close)
`;
}

// Plantilla de ESTRATEGIA real: strategy.entry/exit + Probador integrado.
function strategyTemplate(username: string): string {
  return `// Este código Kai Pine corre en tu terminal — sintaxis Pine v5 (subset).
// © ${username}

//@version=6
strategy("Mi estrategia", overlay=true, initial_capital=10000)
longitudRapida = input.int(9, title="EMA rápida")
longitudLenta = input.int(21, title="EMA lenta")
fast = ta.ema(close, longitudRapida)
slow = ta.ema(close, longitudLenta)
if ta.crossover(fast, slow)
    strategy.entry("L", strategy.long)
if ta.crossunder(fast, slow)
    strategy.entry("S", strategy.short)
plot(fast, color=color.green, title="EMA rápida")
plot(slow, color=color.red, title="EMA lenta")
`;
}

export function PineEditorPanel() {
  const { user } = useAuth();
  const [scripts, setScripts] = useState<PineScript[]>(() => loadScripts());
  const [activeId, setActiveId] = useState<string | null>(() => loadScripts()[0]?.id ?? null);
  const [source, setSource] = useState<string>(() => loadScripts()[0]?.source ?? "");
  const [dirty, setDirty] = useState(false);
  const [consoleMsg, setConsoleMsg] = useState<ConsoleMsg>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // Menú del nombre del script (estilo TradingView) + renombrado inline.
  const [scriptMenuOpen, setScriptMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  // Probador de estrategias (backtest sobre las velas del chart actual).
  const [testerReport, setTesterReport] = useState<StrategyReport | null>(null);
  // Script de SISTEMA activo (Camarón): solo lectura, fijo arriba de la lista.
  const [activeSystemId, setActiveSystemId] = useState<string | null>(null);
  const [camZonesOn, setCamZonesOn] = useState<boolean>(() => isCamaronZonesOn());
  useEffect(() => onCamaronZonesChange(() => setCamZonesOn(isCamaronZonesOn())), []);
  const activeSystem = activeSystemId ? SYSTEM_SCRIPTS.find((s) => s.id === activeSystemId) ?? null : null;
  // Tick para re-leer isPineApplied tras aplicar/quitar.
  const [, setAppliedTick] = useState(0);

  const textRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const active = useMemo(() => scripts.find((s) => s.id === activeId) ?? null, [scripts, activeId]);
  const applied = activeSystemId ? camZonesOn : active ? isPineApplied(active.id) : false;

  // Sin scripts: el editor arranca con la plantilla base (estilo TradingView)
  // listo para escribir; al Guardar/Añadir se convierte en script.
  useEffect(() => {
    if (!active && !source) {
      setSource(blankTemplate(user?.username || "kai"));
    }
    // Solo al montar: no re-inyectar si el usuario borra todo a propósito.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback((next: PineScript[]) => {
    setScripts(next);
    saveScripts(next);
  }, []);

  const openScript = useCallback(
    (id: string) => {
      const s = scripts.find((x) => x.id === id);
      if (!s) return;
      setActiveSystemId(null);
      setActiveId(id);
      setSource(s.source);
      setDirty(false);
      setConsoleMsg(null);
    },
    [scripts],
  );

  const openSystemScript = useCallback((id: string) => {
    const s = SYSTEM_SCRIPTS.find((x) => x.id === id);
    if (!s) return;
    setActiveSystemId(id);
    setActiveId(null);
    setSource(s.source);
    setDirty(false);
    setConsoleMsg(null);
  }, []);

  const createFrom = useCallback(
    (name: string, src: string) => {
      const script: PineScript = { id: newScriptId(), name, source: src, updatedAt: Date.now() };
      const next = [script, ...scripts];
      persist(next);
      setActiveId(script.id);
      setSource(src);
      setDirty(false);
      setConsoleMsg(null);
      setTemplatesOpen(false);
    },
    [scripts, persist],
  );

  const handleSave = useCallback((): PineScript | null => {
    if (!source.trim()) return null;
    const res = compilePine(source);
    let saved: PineScript;
    if (active) {
      // El nombre del script es del USUARIO (renombrable desde el menú): no se
      // pisa con el título de indicator() al guardar.
      saved = { ...active, source, updatedAt: Date.now() };
      persist(scripts.map((s) => (s.id === active.id ? saved : s)));
    } else {
      // Sin script activo: lo que se escribió directo en el editor se convierte
      // en un script nuevo al Guardar / Añadir al chart (nombre = título).
      const name = res.ok ? res.compiled.title : "Mi script";
      saved = { id: newScriptId(), name, source, updatedAt: Date.now() };
      persist([saved, ...scripts]);
      setActiveId(saved.id);
    }
    setDirty(false);
    if (!res.ok) {
      setConsoleMsg({ tone: "error", text: `Guardado con errores — línea ${res.error.line}: ${res.error.message}` });
    } else {
      setConsoleMsg({ tone: "ok", text: "Guardado" });
    }
    return saved;
  }, [active, source, scripts, persist]);

  const handleApply = useCallback(() => {
    // Script de sistema (Camarón): no compila Pine — activa las zonas EN VIVO
    // del motor sobre el chart (telemetría real).
    if (activeSystem) {
      setCamaronZonesOn(true);
      setConsoleMsg({ tone: "ok", text: "Zonas del Camarón EN VIVO aplicadas al chart — se refrescan solas cada 15s" });
      return;
    }
    const script = handleSave();
    if (!script) return;
    const chart = getActiveProChart();
    if (!chart) {
      setConsoleMsg({ tone: "error", text: "El chart aún no está listo — espera a que carguen las velas" });
      return;
    }
    const res = applyPineScript(chart, script);
    if (!res.ok) {
      setConsoleMsg({ tone: "error", text: `Línea ${res.error.line}: ${res.error.message}` });
      return;
    }
    setAppliedTick((t) => t + 1);
    setConsoleMsg({ tone: "ok", text: `Compilado — '${script.name}' aplicado al chart` });
  }, [handleSave, activeSystem]);

  const handleRemoveFromChart = useCallback(() => {
    if (activeSystem) {
      setCamaronZonesOn(false);
      setConsoleMsg({ tone: "info", text: "Zonas del Camarón quitadas del chart" });
      return;
    }
    if (!active) return;
    const chart = getActiveProChart();
    if (chart) removePineScript(chart, active.id);
    setAppliedTick((t) => t + 1);
    setConsoleMsg({ tone: "info", text: `'${active.name}' quitado del chart` });
  }, [active, activeSystem]);

  const handleDelete = useCallback(() => {
    if (!active) return;
    const chart = getActiveProChart();
    if (chart) removePineScript(chart, active.id);
    const next = scripts.filter((s) => s.id !== active.id);
    persist(next);
    const fallback = next[0] ?? null;
    setActiveId(fallback?.id ?? null);
    setSource(fallback?.source ?? "");
    setDirty(false);
    setConsoleMsg({ tone: "info", text: `Script '${active.name}' eliminado` });
  }, [active, scripts, persist]);

  // Probador: compila y corre el broker simulado sobre las velas del chart.
  const handleTestStrategy = useCallback(() => {
    const res = compilePine(source);
    if (!res.ok) {
      setConsoleMsg({ tone: "error", text: `Línea ${res.error.line}: ${res.error.message}` });
      return;
    }
    if (!res.compiled.isStrategy) {
      setConsoleMsg({ tone: "info", text: "Este script es un indicador — para el Probador usa strategy(...) con strategy.entry/exit" });
      return;
    }
    const chart = getActiveProChart();
    const dataList = chart?.getDataList?.() ?? [];
    if (dataList.length === 0) {
      setConsoleMsg({ tone: "error", text: "El chart aún no tiene velas para probar" });
      return;
    }
    const bars = dataList.map((d) => ({
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      volume: d.volume ?? 0,
      time: d.timestamp,
    }));
    const report = res.compiled.runStrategy(bars);
    setTesterReport(report);
    setConsoleMsg(
      report && report.trades.length === 0
        ? { tone: "info", text: "Probador: la estrategia no generó trades en las velas cargadas" }
        : { tone: "ok", text: `Probador: ${report?.trades.length ?? 0} trades sobre ${bars.length} velas del chart` },
    );
    handleSave();
  }, [source, handleSave]);

  // ── Acciones del menú del nombre (estilo TradingView) ──────────────────────

  const handleDuplicate = useCallback(() => {
    if (!active) return;
    const copy: PineScript = {
      id: newScriptId(),
      name: `${active.name} (copia)`,
      source,
      updatedAt: Date.now(),
    };
    persist([copy, ...scripts]);
    setActiveId(copy.id);
    setDirty(false);
    setConsoleMsg({ tone: "info", text: `Copia creada: '${copy.name}'` });
    setScriptMenuOpen(false);
  }, [active, source, scripts, persist]);

  const startRename = useCallback(() => {
    if (!active) return;
    setRenameValue(active.name);
    setRenaming(true);
    setScriptMenuOpen(false);
  }, [active]);

  const commitRename = useCallback(() => {
    setRenaming(false);
    if (!active) return;
    const name = renameValue.trim();
    if (!name || name === active.name) return;
    persist(scripts.map((s) => (s.id === active.id ? { ...s, name, updatedAt: Date.now() } : s)));
  }, [active, renameValue, scripts, persist]);

  const createIndicatorScript = useCallback(() => {
    createFrom("Mi script", blankTemplate(user?.username || "kai"));
    setScriptMenuOpen(false);
  }, [createFrom, user]);

  const createStrategyScript = useCallback(() => {
    createFrom("Mi estrategia", strategyTemplate(user?.username || "kai"));
    setScriptMenuOpen(false);
  }, [createFrom, user]);

  // Gutter de números de línea sincronizado con el scroll del textarea.
  const lineCount = useMemo(() => source.split("\n").length, [source]);
  const onScroll = useCallback(() => {
    if (gutterRef.current && textRef.current) {
      gutterRef.current.scrollTop = textRef.current.scrollTop;
    }
  }, []);

  // Tab inserta 4 espacios en vez de saltar de campo.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        const el = e.currentTarget;
        const { selectionStart, selectionEnd, value } = el;
        const next = `${value.slice(0, selectionStart)}    ${value.slice(selectionEnd)}`;
        setSource(next);
        setDirty(true);
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = selectionStart + 4;
        });
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
      }
    },
    [handleSave],
  );

  // Cerrar menús (plantillas / nombre) al hacer clic fuera.
  useEffect(() => {
    if (!templatesOpen && !scriptMenuOpen) return;
    const close = () => {
      setTemplatesOpen(false);
      setScriptMenuOpen(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [templatesOpen, scriptMenuOpen]);

  return (
    <div className="flex-1 flex min-h-0 text-xs">
      {/* Modal "Nuevo script" — centrado en pantalla (no se recorta en el panel). */}
      {templatesOpen && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
          onClick={() => setTemplatesOpen(false)}
        >
          <div
            className="w-[420px] max-w-[92vw] rounded-lg border border-white/10 bg-[#151824] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
              <span className="text-sm font-semibold text-white">Nuevo script</span>
              <button
                type="button"
                onClick={() => setTemplatesOpen(false)}
                className="text-white/40 hover:text-white/80"
                aria-label="Cerrar"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-3">
              <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-white/35">Crear</div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={createIndicatorScript}
                  className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2.5 text-left text-white/85 hover:bg-white/10"
                >
                  <LineChart className="h-4 w-4 text-[#7ea6ff]" />
                  <div>
                    <div className="font-semibold">Indicador</div>
                    <div className="text-[10px] text-white/40">Se dibuja sobre el chart</div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={createStrategyScript}
                  className="flex items-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2.5 text-left text-white/85 hover:bg-white/10"
                >
                  <Waypoints className="h-4 w-4 text-emerald-400" />
                  <div>
                    <div className="font-semibold">Estrategia</div>
                    <div className="text-[10px] text-white/40">Con órdenes y Probador</div>
                  </div>
                </button>
              </div>
              <div className="px-1 pt-3 pb-1 text-[10px] uppercase tracking-wide text-white/35">Plantillas</div>
              <div className="grid grid-cols-2 gap-1.5">
                {PINE_EXAMPLES.map((ex) => (
                  <button
                    key={ex.name}
                    type="button"
                    onClick={() => createFrom(ex.name, ex.source)}
                    className="rounded-md border border-white/10 px-3 py-2 text-left text-white/70 hover:bg-white/5"
                  >
                    {ex.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Lista de scripts */}
      <div className="w-44 shrink-0 border-r border-white/10 flex flex-col">
        <div className="px-2 py-1.5 flex items-center justify-between border-b border-white/10">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Mis scripts</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setTemplatesOpen(true);
            }}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-white/70 border border-white/15 hover:bg-white/5"
            title="Nuevo script"
          >
            <Plus className="h-3 w-3" /> Nuevo
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {/* Scripts de SISTEMA fijos (Camarón): siempre arriba, no borrables. */}
          {SYSTEM_SCRIPTS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => openSystemScript(s.id)}
              className={cn(
                "w-full px-3 py-2 text-left border-b border-white/5 hover:bg-white/5",
                s.id === activeSystemId ? "bg-white/10 text-white" : "text-white/60",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium">{s.name}</span>
                <span className="shrink-0 rounded border border-[#2f6bff]/40 bg-[#2f6bff]/10 px-1 text-[8px] uppercase tracking-wide text-[#7ea6ff]">
                  sistema
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[9px] text-white/35">
                {camZonesOn && <span className="text-emerald-400">● en chart</span>}
              </div>
            </button>
          ))}
          {scripts.length === 0 && (
            <div className="px-3 py-4 text-white/40 text-[11px] leading-relaxed">
              Sin scripts todavía. Crea uno con <span className="text-white/70">Nuevo</span> — hay plantillas para arrancar.
            </div>
          )}
          {scripts.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => openScript(s.id)}
              className={cn(
                "w-full px-3 py-2 text-left border-b border-white/5 hover:bg-white/5",
                s.id === activeId ? "bg-white/10 text-white" : "text-white/60",
              )}
            >
              <div className="truncate font-medium">{s.name}</div>
              <div className="flex items-center gap-1.5 text-[9px] text-white/35">
                {isPineApplied(s.id) && <span className="text-emerald-400">● en chart</span>}
                {s.id === activeId && dirty && <span className="text-amber-400">sin guardar</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Editor + consola */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="px-2 py-1.5 border-b border-white/10 flex items-center gap-1.5">
          {/* Nombre del script = menú (Guardar / Copia / Renombrar / Crear nuevo), como TradingView. */}
          <div className="relative mr-auto min-w-0" onClick={(e) => e.stopPropagation()}>
            {renaming ? (
              <input
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setRenaming(false);
                }}
                className="bg-[#10131c] border border-[#2f6bff]/60 rounded px-2 py-0.5 text-white outline-none w-48"
              />
            ) : (
              <button
                type="button"
                onClick={() => setScriptMenuOpen((v) => !v)}
                className="flex items-center gap-1 rounded px-2 py-1 text-white/85 font-semibold hover:bg-white/5 max-w-[260px]"
              >
                <span className="truncate">{activeSystem ? activeSystem.name : active ? active.name : "Script sin título"}</span>
                <ChevronDown className="h-3 w-3 shrink-0 text-white/40" />
              </button>
            )}
            {scriptMenuOpen && (
              <div className="absolute left-0 top-7 z-30 w-56 rounded-md border border-white/10 bg-[#151824] py-1 shadow-xl">
                <button
                  type="button"
                  onClick={() => {
                    handleSave();
                    setScriptMenuOpen(false);
                  }}
                  disabled={!source.trim() || !!activeSystem}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 hover:bg-white/5 disabled:opacity-30"
                >
                  <Save className="h-3.5 w-3.5 text-white/40" /> Guardar script
                  <span className="ml-auto text-[9px] text-white/30">Ctrl+S</span>
                </button>
                <button
                  type="button"
                  onClick={handleDuplicate}
                  disabled={!active}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 hover:bg-white/5 disabled:opacity-30"
                >
                  <Copy className="h-3.5 w-3.5 text-white/40" /> Hacer una copia
                </button>
                <button
                  type="button"
                  onClick={startRename}
                  disabled={!active}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 hover:bg-white/5 disabled:opacity-30"
                >
                  <Pencil className="h-3.5 w-3.5 text-white/40" /> Renombrar…
                </button>
                <div className="my-1 border-t border-white/10" />
                <div className="px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-wide text-white/30">Crear nuevo</div>
                <button
                  type="button"
                  onClick={createIndicatorScript}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 hover:bg-white/5"
                >
                  <LineChart className="h-3.5 w-3.5 text-white/40" /> Indicador
                </button>
                <button
                  type="button"
                  onClick={createStrategyScript}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/80 hover:bg-white/5"
                >
                  <Waypoints className="h-3.5 w-3.5 text-white/40" /> Estrategia
                </button>
                {scripts.length > 0 && (
                  <>
                    <div className="my-1 border-t border-white/10" />
                    <div className="px-3 pt-1 pb-0.5 text-[9px] uppercase tracking-wide text-white/30">Abrir script</div>
                    {scripts.slice(0, 6).map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          openScript(s.id);
                          setScriptMenuOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center px-3 py-1.5 text-left hover:bg-white/5 truncate",
                          s.id === activeId ? "text-white" : "text-white/60",
                        )}
                      >
                        {s.name}
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={!source.trim() || !!activeSystem}
            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] border border-white/15 text-white/70 hover:bg-white/5 disabled:opacity-30"
            title="Guardar (Ctrl+S)"
          >
            <Save className="h-3 w-3" /> Guardar
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!source.trim() && !activeSystem}
            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-30"
          >
            <Play className="h-3 w-3" /> {applied ? "Actualizar en chart" : "Añadir al chart"}
          </button>
          <button
            type="button"
            onClick={handleTestStrategy}
            disabled={!source.trim() || !!activeSystem}
            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] border border-[#2f6bff]/40 bg-[#2f6bff]/10 text-[#7ea6ff] hover:bg-[#2f6bff]/20 disabled:opacity-30"
            title="Backtest sobre las velas cargadas en el chart"
          >
            <Waypoints className="h-3 w-3" /> Probar
          </button>
          <button
            type="button"
            onClick={handleRemoveFromChart}
            disabled={(!active && !activeSystem) || !applied}
            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] border border-white/15 text-white/60 hover:bg-white/5 disabled:opacity-30"
          >
            <X className="h-3 w-3" /> Quitar
          </button>
          <button
            type="button"
            onClick={handleDelete}
            disabled={!active}
            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] border border-red-500/30 text-red-400/80 hover:bg-red-500/10 disabled:opacity-30"
            title="Eliminar script"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          <div
            ref={gutterRef}
            className="w-9 shrink-0 overflow-hidden bg-[#10131c] text-right pr-1.5 pt-2 text-[10px] leading-[18px] text-white/25 select-none font-mono"
          >
            {Array.from({ length: lineCount }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <textarea
            ref={textRef}
            value={source}
            spellCheck={false}
            readOnly={!!activeSystem}
            onScroll={onScroll}
            onKeyDown={onKeyDown}
            onChange={(e) => {
              if (activeSystem) return;
              setSource(e.target.value);
              setDirty(true);
            }}
            placeholder={'// Escribe tu indicador aquí, ej.:\n// fast = ta.ema(close, 9)\n// plot(fast, color=color.green)'}
            className="flex-1 resize-none bg-transparent outline-none pt-2 px-2 font-mono text-[11px] leading-[18px] text-white/85 placeholder:text-white/25"
          />
        </div>

        {/* Probador de estrategias (estilo Strategy Tester) */}
        {testerReport && (
          <div className="border-t border-white/10 bg-[#10131c] shrink-0">
            <div className="px-3 py-1 flex items-center gap-4 text-[10px]">
              <span className="uppercase tracking-wide text-white/40">Probador</span>
              <span className={cn("font-mono", testerReport.netProfit >= 0 ? "text-emerald-400" : "text-red-400")}>
                Net: {testerReport.netProfit >= 0 ? "+" : ""}
                {testerReport.netProfit.toFixed(2)} pts
              </span>
              <span className="text-white/60 font-mono">Trades: {testerReport.trades.length}</span>
              <span className="text-white/60 font-mono">
                Ganadoras: {testerReport.winRate == null ? "—" : `${testerReport.winRate.toFixed(1)}%`}
              </span>
              <span className="text-white/60 font-mono">
                PF: {testerReport.profitFactor == null ? "—" : testerReport.profitFactor.toFixed(2)}
              </span>
              <span className="text-white/60 font-mono">DD máx: {testerReport.maxDrawdown.toFixed(2)} pts</span>
              {testerReport.openPosition && (
                <span className="text-amber-400/80 font-mono">
                  Abierta: {testerReport.openPosition.side === "long" ? "LONG" : "SHORT"} ({testerReport.openPosition.unrealized >= 0 ? "+" : ""}
                  {testerReport.openPosition.unrealized.toFixed(2)})
                </span>
              )}
              <button
                type="button"
                onClick={() => setTesterReport(null)}
                className="ml-auto text-white/40 hover:text-white/80"
                aria-label="Cerrar probador"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            {testerReport.trades.length > 0 && (
              <div className="max-h-16 overflow-y-auto px-3 pb-1 text-[9px] font-mono text-white/50">
                {testerReport.trades
                  .slice()
                  .reverse()
                  .slice(0, 50)
                  .map((t, idx) => (
                    <div key={idx} className="flex gap-3">
                      <span className={t.side === "long" ? "text-emerald-400/80" : "text-red-400/80"}>
                        {t.side === "long" ? "LONG " : "SHORT"}
                      </span>
                      <span>
                        {t.entryPrice.toFixed(2)} → {t.exitPrice.toFixed(2)}
                      </span>
                      <span className={t.pnl >= 0 ? "text-emerald-400/80" : "text-red-400/80"}>
                        {t.pnl >= 0 ? "+" : ""}
                        {t.pnl.toFixed(2)}
                      </span>
                      <span className="text-white/30">{t.exitReason}</span>
                      {t.exitTime != null && (
                        <span className="text-white/30">
                          {new Date(t.exitTime).toLocaleString("es-DO", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                        </span>
                      )}
                    </div>
                  ))}
              </div>
            )}
          </div>
        )}

        <div
          className={cn(
            "px-3 py-1.5 border-t border-white/10 text-[10px] font-mono min-h-[26px]",
            consoleMsg?.tone === "error" && "text-red-400",
            consoleMsg?.tone === "ok" && "text-emerald-400",
            (!consoleMsg || consoleMsg.tone === "info") && "text-white/45",
          )}
        >
          {consoleMsg?.text ?? "Consola — errores de compilación salen aquí con su línea"}
        </div>
      </div>
    </div>
  );
}
