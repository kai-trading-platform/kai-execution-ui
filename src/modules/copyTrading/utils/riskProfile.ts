export type FormattedRiskProfileTone = "conservative" | "moderate" | "aggressive" | "neutral";

export interface FormattedRiskProfile {
  label: string;
  tone: FormattedRiskProfileTone;
}

export function formatRiskProfile(profile?: string | null): FormattedRiskProfile {
  const normalized = String(profile || "").trim().toLowerCase();

  if (!normalized) {
    return { label: "Sin perfil", tone: "neutral" };
  }

  if (normalized === "conservative" || normalized === "conservador") {
    return { label: "Conservador", tone: "conservative" };
  }

  if (normalized === "moderate" || normalized === "moderado") {
    return { label: "Moderado", tone: "moderate" };
  }

  if (normalized === "aggressive" || normalized === "agresivo") {
    return { label: "Agresivo", tone: "aggressive" };
  }

  return { label: "Personalizado", tone: "neutral" };
}
