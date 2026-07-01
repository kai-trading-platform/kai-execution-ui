FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

ENV CI=true
ENV PNPM_CONFIG_AUDIT=false

COPY kai-execution-ui/ ./

# Sane defaults for running under docker-compose: the Vite dev proxy runs
# server-side inside this container, so it must reach peers by their compose
# service names, not localhost. Compose overrides these via `environment:`.
ENV VITE_BACKEND_PROXY_TARGET=http://backend-api:3000
ENV VITE_EXECUTION_API_URL=http://kai-execution-api:3001

EXPOSE 5174

CMD ["pnpm", "dev", "--host", "--port", "5174"]
