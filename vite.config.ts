import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig(() => {
  const proxyConfig: Record<string, string | ProxyOptions> = {};

  proxyConfig["/api/trading"] = {
    target: process.env.VITE_EXECUTION_API_URL || "http://localhost:3001",
    changeOrigin: true,
    secure: false,
  } as ProxyOptions;

  proxyConfig["/api"] = {
    target: process.env.VITE_BACKEND_PROXY_TARGET || "http://localhost:3000",
    changeOrigin: true,
    secure: false,
  } as ProxyOptions;

  proxyConfig["/socket.io"] = {
    target: process.env.VITE_BACKEND_PROXY_TARGET || "http://localhost:3000",
    changeOrigin: true,
    secure: false,
    ws: true,
  } as ProxyOptions;

  return {
    server: {
      host: "::",
      port: 5174,
      // Aceptar el subdominio público del túnel (cloudflared → terminal.scyra.dev)
      // además de localhost. Sin esto el dev server de Vite rechaza el Host.
      allowedHosts: [".scyra.dev", "localhost", "127.0.0.1"],
      proxy: proxyConfig,
    },
    // PRODUCCIÓN: se sirve con `vite preview` (build estático, sin HMR ni
    // re-optimización de deps → sin el problema de módulos "stale"). Reusa el
    // MISMO proxy que el dev server para /api, /api/trading y /socket.io.
    preview: {
      host: "::",
      port: 5174,
      allowedHosts: [".scyra.dev", "localhost", "127.0.0.1"],
      proxy: proxyConfig,
    },
    build: {
      outDir: "dist",
      sourcemap: false,
      minify: "terser",
      reportCompressedSize: true,
      chunkSizeWarningLimit: 900,
      rollupOptions: {
        output: {
          entryFileNames: "assets/[name]-[hash].js",
          chunkFileNames: "assets/[name]-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
          manualChunks(id) {
            if (!id.includes("node_modules")) return;
            if (id.includes("lightweight-charts")) {
              return "trading-chart-vendor";
            }
            if (
              id.includes("@radix-ui") ||
              id.includes("cmdk") ||
              id.includes("embla-carousel-react") ||
              id.includes("vaul")
            ) {
              return "ui-vendor";
            }
            if (
              id.includes("@tanstack/react-query") ||
              id.includes("react-router-dom") ||
              id.includes("react-hook-form") ||
              id.includes("zod")
            ) {
              return "app-vendor";
            }
          },
        },
      },
    },
    plugins: [react()],
    resolve: {
      // Array form: el alias regex de @klinecharts/pro debe ser exacto para no
      // interceptar el import del CSS (`@klinecharts/pro/dist/...css`, que sigue
      // saliendo de node_modules). Apuntamos el paquete a NUESTRO fork vendored
      // (vendor/klinecharts-pro) que expone getChart() para dibujar posiciones.
      alias: [
        { find: "@", replacement: path.resolve(__dirname, "./src") },
        {
          find: /^@klinecharts\/pro$/,
          replacement: path.resolve(__dirname, "./vendor/klinecharts-pro/dist/klinecharts-pro.js"),
        },
      ],
    },
  };
});
