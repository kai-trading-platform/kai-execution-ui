FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

ENV CI=true
ENV PNPM_CONFIG_AUDIT=false

COPY kai-execution-ui/package.json kai-execution-ui/pnpm-lock.yaml kai-execution-ui/.npmrc ./
RUN pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile --offline --ignore-scripts

COPY kai-execution-ui/ ./

ENV VITE_BACKEND_PROXY_TARGET=http://localhost:3000
ENV VITE_EXECUTION_API_URL=http://localhost:3001

EXPOSE 5174

CMD ["pnpm", "dev", "--host", "--port", "5174"]
