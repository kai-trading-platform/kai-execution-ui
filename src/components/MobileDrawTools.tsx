import { useState } from "react";
import {
  Pencil,
  X,
  TrendingUp,
  Minus,
  MoveUpRight,
  BarChart3,
  Square,
  Circle,
  Type,
  Eraser,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";

// En móvil la drawing-bar vertical del fork está oculta (CSS). Este FAB + bottom
// sheet le da acceso táctil a las herramientas de dibujo.
const TOOLS: Array<{ name: string; label: string; Icon: LucideIcon; rotate?: boolean }> = [
  { name: "segment", label: "Tendencia", Icon: TrendingUp },
  { name: "horizontalStraightLine", label: "Horizontal", Icon: Minus },
  { name: "verticalStraightLine", label: "Vertical", Icon: Minus, rotate: true },
  { name: "rayLine", label: "Ray", Icon: MoveUpRight },
  { name: "fibonacciLine", label: "Fibonacci", Icon: BarChart3 },
  { name: "rect", label: "Rectángulo", Icon: Square },
  { name: "circle", label: "Círculo", Icon: Circle },
  { name: "simpleAnnotation", label: "Texto", Icon: Type },
];

export function MobileDrawTools({
  onSelectTool,
  onClearDrawings,
}: {
  onSelectTool: (name: string) => void;
  onClearDrawings: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="md:hidden">
      {/* FAB */}
      <button
        onClick={() => setOpen(true)}
        title="Herramientas de dibujo"
        className="pointer-events-auto absolute bottom-3 right-3 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-[#2f6bff] text-white shadow-lg active:scale-95"
      >
        <Pencil className="h-5 w-5" />
      </button>

      {/* Bottom sheet */}
      {open && (
        <>
          <div
            className="pointer-events-auto fixed inset-0 z-40 bg-black/50"
            onClick={() => setOpen(false)}
          />
          <div className="pointer-events-auto fixed inset-x-0 bottom-0 z-50 rounded-t-2xl border-t border-white/10 bg-[#0d0f16] p-4 pb-6">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-sm font-semibold text-white">Herramientas</span>
              <button onClick={() => setOpen(false)} className="text-white/50 hover:text-white">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {TOOLS.map((t) => (
                <button
                  key={t.name}
                  onClick={() => {
                    onSelectTool(t.name);
                    setOpen(false);
                  }}
                  className="flex flex-col items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] py-3 text-[10px] text-white/70 active:bg-white/10"
                >
                  <t.Icon className={cn("h-5 w-5", t.rotate && "rotate-90")} />
                  {t.label}
                </button>
              ))}
              <button
                onClick={() => {
                  onClearDrawings();
                  setOpen(false);
                }}
                className="flex flex-col items-center gap-1 rounded-lg border border-white/10 bg-white/[0.03] py-3 text-[10px] text-[#ef5350] active:bg-white/10"
              >
                <Eraser className="h-5 w-5" />
                Borrar
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
