# Terminal (kai-execution-ui) — PRODUCCIÓN.
#
# Antes corría `vite dev` (bind-mount + HMR). Eso, en "producción", causaba
# módulos "stale": al re-optimizar deps, las pestañas abiertas pedían hashes que
# ya no existían ("Loading failed for the module"). Ahora servimos el BUILD de
# producción con `vite preview` (estático, sin HMR ni re-optimización), que
# además reusa el MISMO proxy del vite.config (/api, /api/trading, /socket.io) y
# corre React en modo prod (sin el doble-montaje de StrictMode).
FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

ENV CI=true
ENV PNPM_CONFIG_AUDIT=false

# Deps primero (capa cacheable). El .dockerignore (raíz del contexto) excluye el
# node_modules/dist del host, así el segundo COPY no pisa el recién instalado.
COPY kai-execution-ui/package.json kai-execution-ui/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile=false

# Fuente (incluye vendor/klinecharts-pro/dist, que el alias del chart necesita).
COPY kai-execution-ui/ ./
RUN pnpm build

# El proxy de `vite preview` corre server-side dentro de este contenedor: debe
# alcanzar a los peers por su nombre de servicio en compose (NO localhost).
# Compose los sobreescribe vía environment:.
ENV VITE_BACKEND_PROXY_TARGET=http://backend-api:3000
ENV VITE_EXECUTION_API_URL=http://kai-execution-api:3001

EXPOSE 5174

CMD ["pnpm", "preview", "--host", "--port", "5174"]
