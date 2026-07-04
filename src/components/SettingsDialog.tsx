import { Settings as SettingsIcon, LineChart, Volume2, SlidersHorizontal, Clock } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { TerminalSettings } from "@/hooks/useTerminalSettings";

const TIMEZONES = [
  { value: "local", label: "Hora local del navegador" },
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "Nueva York (EST/EDT)" },
  { value: "America/Bogota", label: "Bogotá (COT)" },
  { value: "Europe/London", label: "Londres (GMT/BST)" },
  { value: "Europe/Madrid", label: "Madrid (CET/CEST)" },
  { value: "Asia/Tokyo", label: "Tokio (JST)" },
];

function Row({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-[13px] text-white/85">{label}</div>
        {hint && <div className="text-[11px] text-white/40 mt-0.5">{hint}</div>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof LineChart;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-1 text-[11px] font-semibold uppercase tracking-wider text-[#7aa6ee]">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      <div className="divide-y divide-white/5">{children}</div>
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
  settings,
  setSetting,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  settings: TerminalSettings;
  setSetting: <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md border-white/10 bg-[#0d0f16] text-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SettingsIcon className="h-4 w-4 text-[#2f6bff]" /> Configuración
          </DialogTitle>
          <DialogDescription className="sr-only">
            Ajusta qué se muestra en el gráfico, los efectos de sonido y las preferencias de trading.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
          <Section icon={LineChart} title="Mostrar en el gráfico">
            <Row
              label="Posiciones abiertas"
              hint="Línea de entrada de cada operación"
              checked={settings.showPositions}
              onChange={(v) => setSetting("showPositions", v)}
            />
            <Row
              label="TP / SL"
              hint="Líneas de Take Profit y Stop Loss"
              checked={settings.showTpSl}
              onChange={(v) => setSetting("showTpSl", v)}
            />
            <Row
              label="Alertas de precio"
              hint="Líneas de tus alertas activas"
              checked={settings.showAlertLines}
              onChange={(v) => setSetting("showAlertLines", v)}
            />
          </Section>

          <Section icon={Volume2} title="Efectos de sonido">
            <Row
              label="Alertas de precio"
              hint="Sonido al dispararse una alerta"
              checked={settings.soundAlerts}
              onChange={(v) => setSetting("soundAlerts", v)}
            />
            <Row
              label="Cierre por TP / SL"
              hint="Sonido cuando una posición se cierra"
              checked={settings.soundClose}
              onChange={(v) => setSetting("soundClose", v)}
            />
          </Section>

          <Section icon={SlidersHorizontal} title="Ajustes de trading">
            <Row
              label="Fijar TP/SL automáticamente"
              hint="Pre-activa TP y SL al abrir el formulario de orden"
              checked={settings.autoTpSl}
              onChange={(v) => setSetting("autoTpSl", v)}
            />
          </Section>

          <Section icon={Clock} title="Zona horaria">
            <div className="py-2">
              <select
                value={settings.timezone}
                onChange={(e) => setSetting("timezone", e.target.value)}
                className="w-full rounded-md border border-white/10 bg-[#151824] px-2 py-2 text-[13px] text-white/85 outline-none hover:border-white/20 cursor-pointer"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
              </select>
            </div>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
