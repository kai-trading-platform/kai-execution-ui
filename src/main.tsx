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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
