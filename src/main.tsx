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

// SSO handoff desde app.scyra.dev: como el terminal vive en otro subdominio,
// no comparte el localStorage de la app. La app pasa la sesión en el fragmento
// (#sso=...) — que NO viaja al servidor — y aquí la guardamos ANTES de montar
// React, para que el usuario no tenga que volver a loguearse. Luego borramos el
// fragmento para no dejar el token en la URL/historial.
(function consumeSsoHandoff() {
  try {
    const match = window.location.hash.match(/[#&]sso=([^&]+)/);
    if (!match) return;
    const decoded = decodeURIComponent(escape(atob(decodeURIComponent(match[1]))));
    const state = JSON.parse(decoded);
    if (state && state.accessToken) {
      localStorage.setItem("kai:nest-auth", JSON.stringify(state));
    }
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  } catch {
    /* fragmento inválido: se ignora y el terminal pedirá login normal */
  }
})();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
