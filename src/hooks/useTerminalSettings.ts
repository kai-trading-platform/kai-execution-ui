import { useCallback, useEffect, useState } from "react";

// User-controlled terminal preferences (the gear / "Configuración" panel).
// Persisted to localStorage so they survive refreshes. Each flag wires to real
// behavior — no decorative toggles.
export interface TerminalSettings {
  // Mostrar en el gráfico
  showPositions: boolean; // entry lines for open positions
  showTpSl: boolean; // TP / SL lines on the chart
  showAlertLines: boolean; // price-alert lines on the chart
  // Efectos de sonido
  soundAlerts: boolean; // beep when a price alert triggers
  soundClose: boolean; // beep when a position closes by TP/SL
  // Ajustes de trading
  autoTpSl: boolean; // pre-enable TP/SL on the order form
  // Apariencia / zona horaria
  timezone: string; // "local" or an IANA name
}

const DEFAULTS: TerminalSettings = {
  showPositions: true,
  showTpSl: true,
  showAlertLines: true,
  soundAlerts: true,
  soundClose: true,
  autoTpSl: false,
  timezone: "local",
};

const KEY = "kai:settings";

function load(): TerminalSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<TerminalSettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function useTerminalSettings() {
  const [settings, setSettings] = useState<TerminalSettings>(load);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  const setSetting = useCallback(
    <K extends keyof TerminalSettings>(key: K, value: TerminalSettings[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  return { settings, setSetting };
}
