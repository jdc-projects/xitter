# syntax=docker/dockerfile:1
# Reset/seeder image. Build from the repo root (context = monorepo root):
#   docker build -f packages/scripts/Dockerfile -t xitter-reset .
#
# Same turbo-prune strategy as the services: install/build only the
# @xitter/scripts dependency subgraph, then assemble a production runtime.
# Entrypoint is the CronJob entry (reset-job.ts compiled); the same image
# doubles as the seeder runner in-cluster (reset-flow.ts --seed step).
#
# The image carries no config: every target (service URLs, brokers,
# Keycloak, stores) is env-driven - see reset-flow.ts / lib/targets.ts.

FROM node:24-alpine AS prune
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
COPY . .
RUN npx turbo@2 prune @xitter/scripts
# turbo prune drops non-code assets: carry the committed seed content files
# through explicitly (content promotion + CMS reset read them at runtime).
RUN cp -r packages/scripts/data /tmp/scripts-data

FROM node:24-alpine AS build
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
COPY --from=prune /app/out .
RUN --mount=type=cache,target=/root/.npm npm ci
COPY --from=prune /tmp/scripts-data ./packages/scripts/data
RUN npx turbo@2 run build --filter=@xitter/scripts

# Production dependencies from the same pruned lockfile (no dev tooling).
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY --from=prune /app/out .
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app .
COPY --from=build --chown=node:node /app/packages ./packages
USER node
WORKDIR /app/packages/scripts
CMD ["node", "dist/reset-job.js"]
