import { readStoredAuth, writeStoredAuth } from "@/contexts/AuthContext";
import { createHttpError } from "@/api/errors";

// ─── Config ───────────────────────────────────────────────────────────────────

const BACKEND_BASE_URL = String(import.meta.env.VITE_BACKEND_URL || "").trim();
let refreshInFlight: Promise<ReturnType<typeof readStoredAuth>> | null = null;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getApiUrl(path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = BACKEND_BASE_URL.replace(/\/$/, "");

  if (!base) {
    return p;
  }

  if (base.endsWith("/api") && p.startsWith("/api")) {
    return base.replace(/\/api$/, "") + p;
  }

  return base + p;
}

function toError(message: string, status?: number, payload?: Record<string, unknown>) {
  const retryAfter = payload?.retry_after;
  return createHttpError(message, status, {
    retry_after: typeof retryAfter === "number" ? retryAfter : Number(retryAfter) || undefined,
  });
}

function getErrorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  const status = Number((error as { status?: unknown }).status);
  return Number.isFinite(status) ? status : null;
}

// ─── apiFetch (no auth) ───────────────────────────────────────────────────────

export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers = new Headers(init?.headers || {});
  let body = init?.body;
  if (init && "json" in init) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json ?? {});
  }
  const response = await fetch(getApiUrl(path), { ...init, body, credentials: "include", headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const rawMessage = String(payload?.message || payload?.error || `Request failed (${response.status})`);
    const err = toError(rawMessage, response.status, payload);
    throw err;
  }
  return payload as T;
}

// ─── nestAuthFetch ────────────────────────────────────────────────────────────

/**
 * Authenticated fetch to the Nest backend.
 * Automatically retries once with a refreshed token on 401.
 */
export async function nestAuthFetch<T = unknown>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  return withAuthRetry(async (accessToken) => {
    const headers = new Headers(init?.headers || {});
    headers.set("Authorization", `Bearer ${accessToken}`);

    let body = init?.body;
    if (init && "json" in init) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(init.json ?? {});
    }

    const response = await fetch(getApiUrl(path), {
      ...init,
      body,
      credentials: "include",
      headers,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const rawMessage = String(payload?.message || payload?.error || `Request failed (${response.status})`);
      throw toError(rawMessage, response.status, payload);
    }

    return payload as T;
  });
}

async function withAuthRetry<T>(runner: (accessToken: string) => Promise<T>): Promise<T> {
  const state = readStoredAuth();
  if (!state?.accessToken) {
    writeStoredAuth(null);
    throw toError("No hay sesión activa", 401);
  }

  try {
    return await runner(state.accessToken);
  } catch (err: unknown) {
    const status = getErrorStatus(err);
    if (status !== 401) throw err;

    const refreshed = await refreshSession();
    if (!refreshed?.accessToken) throw err;

    try {
      return await runner(refreshed.accessToken);
    } catch (retryErr: unknown) {
      if (getErrorStatus(retryErr) === 401) {
        const latest = readStoredAuth();
        if (latest?.refreshToken === refreshed.refreshToken) {
          writeStoredAuth(null);
        }
      }
      throw retryErr;
    }
  }
}

// Cooldown tras un refresh FALLIDO: sin esto, un token muerto hacía que cada
// poll del terminal (posiciones cada 2s, velas…) disparara otro intento de
// refresh y se comiera el RATE-LIMIT del backend (429 por ~7 min) — con el
// límite quemado ni la cookie SSO de Kai podía rescatar la sesión.
let refreshFailedAt = 0;
const REFRESH_FAIL_COOLDOWN_MS = 30_000;

async function refreshSession() {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  if (Date.now() - refreshFailedAt < REFRESH_FAIL_COOLDOWN_MS) {
    return null;
  }

  refreshInFlight = (async () => {
    const activeState = readStoredAuth();
    if (!activeState) {
      return null;
    }

    // If there's no stored refresh token (cookie-based session), still attempt
    // the refresh — the backend can rotate from the httpOnly cookie. Previously
    // we bailed out here WITHOUT clearing the stored session, leaving the app
    // in a zombie half-authenticated state (expired access token + endless
    // 401s + a terminal stuck on "Cargando...").
    let res = await fetch(getApiUrl("/api/auth/refresh"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        activeState.refreshToken ? { refreshToken: activeState.refreshToken } : {},
      ),
    });

    // El refresh token LOCAL puede estar vencido/revocado, pero la cookie SSO
    // de Kai (dominio .scyra.dev, httpOnly) puede seguir viva: reintento
    // solo-cookie para que el terminal HEREDE la sesión de Kai en vez de
    // botar al usuario al login teniendo Kai abierto.
    if (!res.ok && activeState.refreshToken) {
      try {
        res = await fetch(getApiUrl("/api/auth/refresh"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
      } catch {
        /* cae al manejo de !res.ok de abajo */
      }
    }

    if (!res.ok) {
      refreshFailedAt = Date.now();
      // Prevent stale concurrent refresh failures from wiping a newer session.
      const latest = readStoredAuth();
      if (latest?.refreshToken === activeState.refreshToken) {
        writeStoredAuth(null);
      }
      return null;
    }
    refreshFailedAt = 0;

    const payload = await res.json();
    const nextAccessToken = String(payload?.accessToken || "");
    if (!nextAccessToken) {
      // A 200 with no access token is a failed refresh — don't persist empty
      // tokens (which would leave the app in a half-authenticated state).
      writeStoredAuth(null);
      return null;
    }
    const next = {
      accessToken: nextAccessToken,
      refreshToken: String(payload?.refreshToken || ""),
      user: {
        id: String(payload?.user?.id || ""),
        email: String(payload?.user?.email || ""),
        username: String(payload?.user?.username || ""),
        role: String(payload?.user?.role || "USER"),
        createdAt: String(payload?.user?.createdAt || ""),
        updatedAt: String(payload?.user?.updatedAt || ""),
      },
    };
    writeStoredAuth(next);
    return next;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}
