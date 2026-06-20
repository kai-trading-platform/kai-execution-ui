import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
export default defineConfig(() => {
    const proxyConfig = {};
    proxyConfig["/api"] = {
        target: process.env.VITE_BACKEND_PROXY_TARGET || "http://localhost:3000",
        changeOrigin: true,
        secure: false,
    };
    proxyConfig["/socket.io"] = {
        target: process.env.VITE_BACKEND_PROXY_TARGET || "http://localhost:3000",
        changeOrigin: true,
        secure: false,
        ws: true,
    };
    return {
        server: {
            host: "::",
            port: 5174,
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
                        if (!id.includes("node_modules"))
                            return;
                        if (id.includes("lightweight-charts")) {
                            return "trading-chart-vendor";
                        }
                        if (id.includes("@radix-ui") ||
                            id.includes("cmdk") ||
                            id.includes("embla-carousel-react") ||
                            id.includes("vaul")) {
                            return "ui-vendor";
                        }
                        if (id.includes("@tanstack/react-query") ||
                            id.includes("react-router-dom") ||
                            id.includes("react-hook-form") ||
                            id.includes("zod")) {
                            return "app-vendor";
                        }
                    },
                },
            },
        },
        plugins: [react()],
        resolve: {
            alias: {
                "@": path.resolve(__dirname, "./src"),
            },
        },
    };
});
