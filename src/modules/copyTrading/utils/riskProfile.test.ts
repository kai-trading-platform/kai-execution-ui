import { describe, expect, it } from "vitest";

import { formatRiskProfile } from "./riskProfile";

describe("formatRiskProfile", () => {
  it("formats known risk profiles in Spanish", () => {
    expect(formatRiskProfile("conservative")).toEqual({ label: "Conservador", tone: "conservative" });
    expect(formatRiskProfile("conservador")).toEqual({ label: "Conservador", tone: "conservative" });
    expect(formatRiskProfile("moderate")).toEqual({ label: "Moderado", tone: "moderate" });
    expect(formatRiskProfile("moderado")).toEqual({ label: "Moderado", tone: "moderate" });
    expect(formatRiskProfile("aggressive")).toEqual({ label: "Agresivo", tone: "aggressive" });
    expect(formatRiskProfile("agresivo")).toEqual({ label: "Agresivo", tone: "aggressive" });
  });

  it("uses neutral labels for missing or unknown profiles", () => {
    expect(formatRiskProfile(null)).toEqual({ label: "Sin perfil", tone: "neutral" });
    expect(formatRiskProfile("custom")).toEqual({ label: "Personalizado", tone: "neutral" });
  });
});
