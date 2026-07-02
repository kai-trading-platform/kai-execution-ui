import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// klinecharts imprime un banner "❤️ Welcome to klinecharts..." en dev
// (NODE_ENV=development) sin opción para desactivarlo. Lo filtramos aquí.
const originalLog = console.log.bind(console);
console.log = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].includes("Welcome to klinecharts")) {
    return;
  }
  originalLog(...args);
};

// SSO handoff desde app.scyra.dev: el terminal vive en otro subdominio y no
// comparte el localStorage de la app. La app deja la sesión en una cookie de
// dominio `.scyra.dev` (compartida entre subdominios) originada en su sesión YA
// autenticada; aquí la consumimos ANTES de montar React y la borramos.
//
// Seguridad: NO se usa el fragmento de la URL (#sso=) — eso permitía *session
// fixation* (un atacante mandaba un link con su token). Una cookie de
// `.scyra.dev` no la puede setear un tercero en el navegador de la víctima, así
// que el handoff solo funciona con la sesión real del propio usuario.
(function consumeSsoHandoff() {
  try {
    const m = document.cookie.match(/(?:^|;\s*)kai_sso=([^;]+)/);
    if (!m) return;
    // Borrar la cookie de inmediato (un solo uso), pase lo que pase al parsear.
    document.cookie =
      "kai_sso=; domain=.scyra.dev; path=/; max-age=0; SameSite=Lax; Secure";
    const decoded = decodeURIComponent(escape(atob(decodeURIComponent(m[1]))));
    const state = JSON.parse(decoded);
    if (state && state.accessToken) {
      localStorage.setItem("kai:nest-auth", JSON.stringify(state));
    }
  } catch {
    /* cookie inválida: se ignora y el terminal pedirá login normal */
  }
})();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
