# syntax=docker/dockerfile:1
# search-index worker image. Build from the repo root (context = monorepo root):
#   docker build -f apps/workers/search-index/Dockerfile -t xitter-search-index .
#
# Same turbo-prune strategy as the services: install/build only this
# workspace's dependency subgraph, then assemble a production-deps runtime.
# The worker is headless (Kafka consumer); its only listener is the metrics
# server, which also answers /healthz liveness probes.

FROM node:24-alpine AS prune
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
COPY . .
RUN npx turbo@2 prune @xitter/worker-search-index

FROM node:24-alpine AS build
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
COPY --from=prune /app/out .
RUN --mount=type=cache,target=/root/.npm npm ci
# Builds @xitter/* dependencies, then compiles with tsc (ESM output).
RUN npx turbo@2 run build --filter=@xitter/worker-search-index

# Production dependencies from the same pruned lockfile (no dev tooling).
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY --from=prune /app/out .
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
# Overlay build outputs (packages/*/dist, worker dist).
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app .
USER node
# METRICS_PORT is env-driven via @xitter/config; 9103 is the local default.
EXPOSE 9103
WORKDIR /app/apps/workers/search-index
CMD ["node", "dist/main.js"]
