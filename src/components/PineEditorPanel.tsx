import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Play, Plus, Save, Trash2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { compilePine } from "@/lib/pine/compilePine";
import { PINE_EXAMPLES } from "@/lib/pine/examples";
import { applyPineScript, isPineApplied, removePineScript } from "@/lib/pine/pineChart";
import { getActiveProChart } from "@/lib/chartPro/chartInstance";
import { loadScripts, newScriptId, saveScripts, type PineScript } from "@/lib/pine/pineStore";

// Editor Kai Pine (pestaña PINE del panel inferior): lista de scripts +
// textarea con gutter de líneas + consola. Sin dependencias de editor: un
// <textarea> monoespaciado con números de línea sincronizados por scroll.

type ConsoleMsg = { tone: "ok" | "error" | "info"; text: string } | null;

export function PineEditorPanel() {
  const [scripts, setScripts] = useState<PineScript[]>(() => loadScripts());
  const [activeId, setActiveId] = useState<string | null>(() => loadScripts()[0]?.id ?? null);
  const [source, setSource] = useState<string>(() => loadScripts()[0]?.source ?? "");
  const [dirty, setDirty] = useState(false);
  const [consoleMsg, setConsoleMsg] = useState<ConsoleMsg>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  // Tick para re-leer isPineApplied tras aplicar/quitar.
  const [, setAppliedTick] = useState(0);

  const textRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const active = useMemo(() => scripts.find((s) => s.id === activeId) ?? null, [scripts, activeId]);
  const applied = active ? isPineApplied(active.id) : false;

  const persist = useCallback((next: PineScript[]) => {
    setScripts(next);
    saveScripts(next);
  }, []);

  const openScript = useCallback(
    (id: string) => {
      const s = scripts.find((x) => x.id === id);
      if (!s) return;
      setActiveId(id);
      setSource(s.source);
      setDirty(false);
      setConsoleMsg(null);
    },
    [scripts],
  );

  const createFrom = useCallback(
    (name: string, src: string) => {
      const script: PineScript = { id: newScriptId(), name, source: src, updatedAt: Date.now() };
      const next = [script, ...scripts];
      persist(next);
      setActiveId(script.id);
      setSource(src);
      setDirty(false);
      setConsoleMsg({ tone: "info", text: `Nuevo script '${name}' — edítalo y dale a Guardar / Añadir al chart` });
      setTemplatesOpen(false);
    },
    [scripts, persist],
  );

  const handleSave = useCallback((): PineScript | null => {
    if (!active) return null;
    // El nombre visible sale del título de indicator() si compila; si no, se queda.
    const res = compilePine(source);
    const name = res.ok ? res.compiled.title : active.name;
    const updated: PineScript = { ...active, name, source, updatedAt: Date.now() };
    persist(scripts.map((s) => (s.id === active.id ? updated : s)));
    setDirty(false);
    if (!res.ok) {
      setConsoleMsg({ tone: "error", text: `Guardado con errores — línea ${res.error.line}: ${res.error.message}` });
    } else {
      setConsoleMsg({ tone: "ok", text: "Guardado" });
    }
    return updated;
  }, [active, source, scripts, persist]);

  const handleApply = useCallback(() => {
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
  }, [handleSave]);

  const handleRemoveFromChart = useCallback(() => {
    if (!active) return;
    const chart = getActiveProChart();
    if (chart) removePineScript(chart, active.id);
    setAppliedTick((t) => t + 1);
    setConsoleMsg({ tone: "info", text: `'${active.name}' quitado del chart` });
  }, [active]);

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

  // Cerrar el menú de plantillas al hacer clic fuera.
  useEffect(() => {
    if (!templatesOpen) return;
    const close = () => setTemplatesOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [templatesOpen]);

  return (
    <div className="flex-1 flex min-h-0 text-xs">
      {/* Lista de scripts */}
      <div className="w-44 shrink-0 border-r border-white/10 flex flex-col">
        <div className="px-2 py-1.5 flex items-center justify-between border-b border-white/10">
          <span className="text-[10px] uppercase tracking-wide text-white/40">Mis scripts</span>
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setTemplatesOpen((v) => !v)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-white/70 border border-white/15 hover:bg-white/5"
              title="Nuevo script"
            >
              <Plus className="h-3 w-3" /> Nuevo
            </button>
            {templatesOpen && (
              <div className="absolute right-0 top-6 z-30 w-52 rounded-md border border-white/10 bg-[#151824] py-1 shadow-xl">
                <button
                  type="button"
                  className="w-full px-3 py-1.5 text-left text-white/80 hover:bg-white/5"
                  onClick={() => createFrom("Mi indicador", 'indicator("Mi indicador", overlay=true)\nplot(close, color=color.blue)\n')}
                >
                  Script en blanco
                </button>
                <div className="px-3 pt-1.5 pb-0.5 text-[9px] uppercase tracking-wide text-white/30">Plantillas</div>
                {PINE_EXAMPLES.map((ex) => (
                  <button
                    key={ex.name}
                    type="button"
                    className="w-full px-3 py-1.5 text-left text-white/70 hover:bg-white/5"
                    onClick={() => createFrom(ex.name, ex.source)}
                  >
                    {ex.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
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
          <span className="text-white/80 font-semibold truncate">{active ? active.name : "Kai Pine"}</span>
          <span className="text-[9px] text-white/30 mr-auto">sintaxis Pine v5 (subset) · ta.* math.* color.*</span>
          <button
            type="button"
            onClick={handleSave}
            disabled={!active}
            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] border border-white/15 text-white/70 hover:bg-white/5 disabled:opacity-30"
            title="Guardar (Ctrl+S)"
          >
            <Save className="h-3 w-3" /> Guardar
          </button>
          <button
            type="button"
            onClick={handleApply}
            disabled={!active}
            className="flex items-center gap-1 rounded px-2 py-1 text-[10px] border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-30"
          >
            <Play className="h-3 w-3" /> {applied ? "Actualizar en chart" : "Añadir al chart"}
          </button>
          <button
            type="button"
            onClick={handleRemoveFromChart}
            disabled={!active || !applied}
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
            onScroll={onScroll}
            onKeyDown={onKeyDown}
            onChange={(e) => {
              setSource(e.target.value);
              setDirty(true);
            }}
            placeholder={active ? "" : "Crea un script con el botón Nuevo →"}
            disabled={!active}
            className="flex-1 resize-none bg-transparent outline-none pt-2 px-2 font-mono text-[11px] leading-[18px] text-white/85 placeholder:text-white/25 disabled:opacity-40"
          />
        </div>

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
