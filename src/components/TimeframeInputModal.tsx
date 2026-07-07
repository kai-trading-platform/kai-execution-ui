import { timeframeInputLabel } from "@/lib/chartPro/periods";

/**
 * Modal "Cambiar Intervalo" (estilo TradingView): mientras el usuario teclea un
 * número, muestra lo tecleado + el subtítulo dinámico. `input == null` = oculto.
 */
export function TimeframeInputModal({ input }: { input: string | null }) {
  if (input == null) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-[60] flex items-center justify-center">
      <div className="rounded-2xl border border-white/10 bg-[#0d0f16]/95 px-10 py-7 text-center shadow-2xl backdrop-blur">
        <div className="font-mono text-5xl font-bold tabular-nums text-white">{input || "…"}</div>
        <div className="mt-1.5 text-xs uppercase tracking-wider text-[#2f6bff]">
          {timeframeInputLabel(input)}
        </div>
        <div className="mt-2.5 text-[10px] text-white/35">Enter para aplicar</div>
      </div>
    </div>
  );
}
