import { useEffect } from "react";

import { useAuth } from "@/contexts/AuthContext";
import { nestAuthFetch } from "@/api/client";

// Cierre de sesión por INACTIVIDAD del usuario, con el MISMO tiempo configurado
// en Kai (SESSION_LOCK_TIMEOUT_MS del backend, default 4h; se lee del endpoint
// de session-lock). Sin esto el terminal jamás expiraba: su polling de
// posiciones/velas refresca los tokens para siempre aunque nadie toque nada.
// La inactividad se mide por interacción REAL (mouse/teclado/touch), no por
// tráfico de red.

const FALLBACK_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60_000;
const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = ["mousemove", "mousedown", "keydown", "touchstart", "wheel"];

export function useInactivityLogout(): void {
  const { isAuthenticated, logout } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;

    let timeoutMs = FALLBACK_TIMEOUT_MS;
    let lastActivity = Date.now();
    let cancelled = false;

    // El timeout canónico vive en el backend (mismo valor que usa Kai).
    void nestAuthFetch<{ timeoutMs?: number }>("/api/profile/session-lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status" }),
    })
      .then((res) => {
        const t = Number(res?.timeoutMs);
        if (!cancelled && Number.isFinite(t) && t >= 60_000) timeoutMs = t;
      })
      .catch(() => {
        /* fallback 4h */
      });

    const bump = () => {
      lastActivity = Date.now();
    };
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, bump, { passive: true });
    }

    const interval = setInterval(() => {
      if (Date.now() - lastActivity >= timeoutMs) {
        clearInterval(interval);
        void logout();
      }
    }, CHECK_EVERY_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, bump);
      }
    };
  }, [isAuthenticated, logout]);
}
