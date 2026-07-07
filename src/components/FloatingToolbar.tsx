import { useCallback, useEffect, useRef, useState } from "react";
import { GripVertical, PenLine } from "lucide-react";
import { useFavTools } from "@/lib/chartPro/favTools";
import { TOOL_ICONS } from "@/lib/chartPro/toolIcons";

// Tooltips (los iconos vienen de TOOL_ICONS = SVG reales del fork).
const TOOL_LABELS: Record<string, string> = {
  segment: "Tendencia",
  straightLine: "Línea recta",
  rayLine: "Ray",
  horizontalStraightLine: "Horizontal",
  horizontalRayLine: "Ray horizontal",
  horizontalSegment: "Segmento H",
  verticalStraightLine: "Vertical",
  verticalRayLine: "Ray vertical",
  verticalSegment: "Segmento V",
  priceLine: "Precio",
  priceChannelLine: "Canal de precio",
  parallelStraightLine: "Paralelas",
  arrow: "Flecha",
  fibonacciLine: "Fibonacci",
  fibonacciSegment: "Fib segmento",
  fibonacciCircle: "Fib círculo",
  fibonacciSpiral: "Fib espiral",
  fibonacciExtension: "Fib extensión",
  fibonacciSpeedResistanceFan: "Fib abanico",
  gannBox: "Gann Box",
  rect: "Rectángulo",
  circle: "Círculo",
  triangle: "Triángulo",
  parallelogram: "Paralelogramo",
  threeWaves: "3 ondas",
  fiveWaves: "5 ondas",
  eightWaves: "8 ondas",
  anyWaves: "Ondas",
  abcd: "ABCD",
  xabcd: "XABCD",
  simpleAnnotation: "Texto",
  positionLong: "Long",
  positionShort: "Short",
};

const POS_KEY = "kai.chart.floatingToolbarPos";
const DEFAULT_POS = { x: 62, y: 10 };

function readPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p?.x === "number" && typeof p?.y === "number") return p;
    }
  } catch {
    /* noop */
  }
  return DEFAULT_POS;
}

/**
 * Barra flotante arrastrable con las herramientas de dibujo favoritas. Los iconos
 * son los SVG REALES del fork (TOOL_ICONS) → coinciden con la drawing-bar. Solo se
 * muestra si hay ≥1 favorita.
 */
export function FloatingToolbar({ onSelectTool }: { onSelectTool: (name: string) => void }) {
  const { favs } = useFavTools();
  const [pos, setPos] = useState(readPos);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [pos],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      setPos({ x: Math.max(0, e.clientX - dragRef.current.dx), y: Math.max(0, e.clientY - dragRef.current.dy) });
    };
    const onUp = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(pos));
      } catch {
        /* noop */
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [pos]);

  if (favs.length === 0) return null;

  return (
    <div
      className="pointer-events-auto absolute z-30 flex items-center gap-0.5 rounded-md border border-white/10 bg-[#0d0f16]/95 p-0.5 shadow-lg backdrop-blur"
      style={{ left: pos.x, top: pos.y }}
    >
      <span
        onPointerDown={onPointerDown}
        className="flex cursor-grab items-center text-white/30 hover:text-white/60 active:cursor-grabbing"
        title="Arrastrar"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </span>
      {favs.map((name) => {
        const icon = TOOL_ICONS[name];
        return (
          <button
            key={name}
            onClick={() => onSelectTool(name)}
            title={TOOL_LABELS[name] ?? name}
            className="flex h-6 w-6 items-center justify-center rounded text-white/70 transition-colors hover:bg-white/10 hover:text-white"
          >
            {icon ? (
              <svg
                viewBox={icon.viewBox}
                className="h-4 w-4"
                style={{ fill: "currentColor", stroke: "currentColor" }}
                dangerouslySetInnerHTML={{ __html: icon.inner }}
              />
            ) : (
              <PenLine className="h-3.5 w-3.5" />
            )}
          </button>
        );
      })}
    </div>
  );
}
