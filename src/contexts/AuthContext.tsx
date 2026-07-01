/* eslint-disable react-refresh/only-export-components -- AuthContext exporta intencionalmente tanto el provider como utilidades (readStoredAuth, writeStoredAuth, AUTH_STORAGE_EVENT) */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { createHttpError } from "@/api/errors";

const STORAGE_KEY = "kai:nest-auth";
export const AUTH_STORAGE_EVENT = "kai:auth-storage-changed";
type ViteEnvShape = { VITE_BACKEND_URL?: string };
const BACKEND_BASE_URL = String(
  (import.meta.env as ViteEnvShape).VITE_BACKEND_URL || "",
).trim();

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  role: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredAuthState {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

interface AuthContextValue {
  user: AuthUser | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  /** True only during the initial localStorage read on mount */
  isLoading: boolean;
  login(identifier: string, password: string, rememberMe?: boolean): Promise<void>;
  register(email: string, username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  /** Re-reads state from localStorage (called by nestAuthFetch after a refresh) */
  syncFromStorage(): void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getApiUrl(path: string) {
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

export function readStoredAuth(): StoredAuthState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredAuthState) : null;
  } catch {
    return null;
  }
}

export function writeStoredAuth(state: StoredAuthState | null) {
  if (!state) {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(AUTH_STORAGE_EVENT));
  }
}

function normalizePayload(payload: unknown): StoredAuthState {
  const root = asRecord(payload);
  const user = asRecord(root.user);
  return {
    accessToken: String(root.accessToken || ""),
    refreshToken: String(root.refreshToken || ""),
    user: {
      id: String(user.id || ""),
      email: String(user.email || ""),
      username: String(
        user.username ||
          String(user.email || "").split("@")[0] ||
          "",
      ),
      role: String(user.role || "USER"),
      createdAt: String(user.createdAt || new Date().toISOString()),
      updatedAt: String(user.updatedAt || new Date().toISOString()),
    },
  };
}

async function postAuth(path: string, body: Record<string, unknown>) {
  const res = await fetch(getApiUrl(path), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const rawMessage = String(
      payload?.message ||
        payload?.error ||
        `Request failed (${res.status})`,
    );
    console.error("[auth] request failed", { path, status: res.status, rawMessage });
    throw Object.assign(createHttpError(rawMessage, res.status), {
      payload,
    });
  }
  return payload;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Read persisted session synchronously to avoid transient unauth redirects on hard refresh.
  const [state, setState] = useState<StoredAuthState | null>(() =>
    readStoredAuth(),
  );
  const [isLoading, setIsLoading] = useState(true);

  // Initial read from localStorage + cross-origin bootstrap
  useEffect(() => {
    const syncState = () => {
      setState(readStoredAuth());
      setIsLoading(false);
    };

    const handleStorage = (event: StorageEvent) => {
      if (event.key && event.key !== STORAGE_KEY) return;
      syncState();
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(AUTH_STORAGE_EVENT, syncState);

    // ── Cross-origin bootstrap ────────────────────────────────────────────
    // kai-execution-ui (port 5174) is a separate origin from kai-frontend
    // (port 80), so they don't share localStorage. When the user opens the
    // terminal from the "Operar" button, the refresh cookie is sent (same
    // domain, sameSite=Lax). If we have no access token in localStorage,
    // try a silent refresh to bootstrap a session. We keep isLoading=true
    // until this attempt settles so the guard doesn't flash the login screen
    // before a valid cookie-based session has had a chance to resolve.
    if (readStoredAuth()) {
      setIsLoading(false);
    } else {
      void (async () => {
        try {
          const res = await fetch(getApiUrl("/api/auth/refresh"), {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          });
          if (res.ok) {
            const payload = await res.json();
            const next = normalizePayload(payload);
            writeStoredAuth(next);
            setState(next);
          }
        } catch {
          // best-effort; user can still log in manually via the login screen
        } finally {
          setIsLoading(false);
        }
      })();
    }

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(AUTH_STORAGE_EVENT, syncState);
    };
  }, []);

  const syncFromStorage = useCallback(() => {
    setState(readStoredAuth());
  }, []);

  const login = useCallback(async (identifier: string, password: string, rememberMe?: boolean) => {
    const payload = await postAuth("/api/auth/login", { identifier, password, rememberMe });
    const next = normalizePayload(payload);
    writeStoredAuth(next);
    setState(next);
  }, []);

  const register = useCallback(
    async (email: string, username: string, password: string) => {
      const payload = await postAuth("/api/auth/register", {
        email,
        username,
        password,
      });
      const next = normalizePayload(payload);
      writeStoredAuth(next);
      setState(next);
    },
    [],
  );

  const logout = useCallback(async () => {
    const current = readStoredAuth();
    try {
      if (current?.refreshToken) {
        await fetch(getApiUrl("/api/auth/logout"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: current.refreshToken }),
        });
      }
    } catch {
      // best-effort
    }
    writeStoredAuth(null);
    setState(null);
  }, []);

  const value: AuthContextValue = {
    user: state?.user ?? null,
    accessToken: state?.accessToken ?? null,
    isAuthenticated: !!state?.user,
    isLoading,
    login,
    register,
    logout,
    syncFromStorage,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
