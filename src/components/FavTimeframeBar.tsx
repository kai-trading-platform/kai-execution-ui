import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { TIMEFRAME_CATEGORIES } from "@/lib/chartPro/periods";
import { useFavTimeframes } from "@/lib/chartPro/favTimeframes";

/**
 * Barra de temporalidades favoritas (estilo TradingView). Muestra los TFs que el
 * usuario ancló (⭐) como botones de acceso rápido, y un menú para gestionarlos:
 * lista TODOS los TFs disponibles, cada uno con una estrella para favoritear.
 * Persistencia en localStorage vía `useFavTimeframes`.
 */
export function FavTimeframeBar({
  timeframe,
  onSelect,
}: {
  timeframe: string;
  onSelect: (tf: string) => void;
}) {
  const { favs, toggle, isFav } = useFavTimeframes();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-white/10 bg-[#0d0f16] px-2 py-1">
      {favs.map((tf) => (
        <button
          key={tf}
          onClick={() => onSelect(tf)}
          className={cn(
            "rounded px-2 py-0.5 text-[11px] font-semibold transition-colors",
            timeframe === tf
              ? "bg-[#2f6bff]/15 text-[#2f6bff]"
              : "text-white/60 hover:bg-white/5 hover:text-white",
          )}
        >
          {tf}
        </button>
      ))}

      {favs.length === 0 && (
        <span className="px-1 text-[11px] text-white/40">Sin favoritos — usá la ⭐</span>
      )}

      {/* Menú de gestión: todos los TFs con estrella para favoritear/quitar. */}
      <div className="relative ml-auto" ref={ref}>
        <button
          onClick={() => setOpen((o) => !o)}
          title="Gestionar temporalidades favoritas"
          className="flex items-center rounded px-1.5 py-0.5 text-white/40 transition-colors hover:bg-white/5 hover:text-white"
        >
          <Star className="h-3.5 w-3.5" />
        </button>
        {open && (
          <div className="absolute right-0 top-full z-50 mt-1 max-h-80 w-44 overflow-y-auto rounded-md border border-white/10 bg-[#0d0f16] py-1 shadow-lg">
            {TIMEFRAME_CATEGORIES.map((cat) => (
              <div key={cat.label}>
                <div className="px-2 pb-0.5 pt-1.5 text-[9px] font-semibold uppercase tracking-wider text-white/35">
                  {cat.label}
                </div>
                {cat.timeframes.map((tf) => (
                  <div
                    key={tf}
                    className="group flex items-center justify-between gap-2 px-2 py-1 text-[11px] hover:bg-white/5"
                  >
                    <button
                      onClick={() => {
                        onSelect(tf);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex-1 text-left",
                        timeframe === tf ? "text-[#2f6bff]" : "text-white/80",
                      )}
                    >
                      {tf}
                    </button>
                    <button
                      onClick={() => toggle(tf)}
                      title={isFav(tf) ? "Quitar de favoritos" : "Agregar a favoritos"}
                      // La estrella aparece al hover (estilo TradingView); las ya
                      // favoritas quedan siempre visibles.
                      className={cn("shrink-0", !isFav(tf) && "opacity-0 group-hover:opacity-100")}
                    >
                      <Star
                        className={cn(
                          "h-3.5 w-3.5 transition-colors",
                          isFav(tf)
                            ? "fill-amber-400 text-amber-400"
                            : "text-white/40 hover:text-white/70",
                        )}
                      />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
