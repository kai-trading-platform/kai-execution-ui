export type HttpError = Error & {
  status?: number;
  userMessage?: string;
  debugMessage?: string;
  retry_after?: number;
};

function normalizeMessage(message: string): string {
  return String(message || "").trim();
}

export function getUserFriendlyHttpMessage(status: number | undefined, rawMessage: string): string {
  const normalized = normalizeMessage(rawMessage);
  const lower = normalized.toLowerCase();

  if (status === 401) {
    if (lower.includes("no hay sesión activa")) {
      return "No hay sesión activa";
    }
    if (lower.includes("account not approved")) {
      return "Cuenta no aprobada. Un administrador debe aprobar tu cuenta para continuar.";
    }
    if (lower.includes("invalid login credentials")) {
      return "Credenciales inválidas. Verificá tu email y contraseña.";
    }
    return "Tu sesión expiró. Inicia sesión nuevamente.";
  }

  if (status === 403) {
    return "No tienes permisos para realizar esta acción.";
  }

  if (status === 404) {
    return "No se encontró el recurso solicitado.";
  }

  if (status === 405) {
    return "No pudimos procesar tu solicitud en este momento. Intenta nuevamente.";
  }

  if (status === 429) {
    return "Demasiadas solicitudes. Intenta de nuevo en un momento.";
  }

  if (typeof status === "number" && status >= 500) {
    return "Servicio temporalmente no disponible. Intenta nuevamente en unos minutos.";
  }

  if (!status || status <= 0) {
    return "No se pudo conectar con el servidor. Verifica tu conexión e intenta de nuevo.";
  }

  return normalized || "Ocurrió un error inesperado.";
}

export function createHttpError(
  rawMessage: string,
  status?: number,
  extras?: Partial<Pick<HttpError, "retry_after">>,
): HttpError {
  const normalized = normalizeMessage(rawMessage);
  const userMessage = getUserFriendlyHttpMessage(status, normalized);

  return Object.assign(new Error(userMessage), {
    status,
    userMessage,
    debugMessage: normalized,
    ...extras,
  });
}
