# syntax=docker/dockerfile:1
# search service image. Build from the repo root (context = monorepo root):
#   docker build -f apps/services/search/Dockerfile -t xitter-search .
#
# Strategy: `turbo prune` produces the workspace subgraph (this service + the
# @xitter/* packages it depends on) with a matching lockfile, so installs never
# pull other apps' dependencies and the runtime image carries only what this
# service needs. Build happens in-image (incl. `prisma generate` - the
# generated client is gitignored, so images must never rely on a checkout).

FROM node:24-alpine AS prune
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
COPY . .
RUN npx turbo@2 prune @xitter/service-search

FROM node:24-alpine AS build
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
COPY --from=prune /app/out .
RUN --mount=type=cache,target=/root/.npm npm ci
# Builds @xitter/* dependencies, generates the Prisma client into
# src/generated/prisma, then compiles with tsc (tsconfig.build.json).
RUN npx turbo@2 run build --filter=@xitter/service-search

# Production dependencies from the same pruned lockfile (no dev tooling).
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY --from=prune /app/out .
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
# Overlay build outputs (packages/*/dist, service dist + generated client).
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app .
USER node
# PORT (and all endpoints) are env-driven via @xitter/config; 8105 is the
# local default. The image runs no migrations - deploy wiring owns those.
EXPOSE 8105
WORKDIR /app/apps/services/search
CMD ["node", "dist/main.js"]
