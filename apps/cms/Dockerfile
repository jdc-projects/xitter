# syntax=docker/dockerfile:1
# cms (Payload 3 on Next.js) image. Build from the repo root:
#   docker build -f apps/cms/Dockerfile -t xitter-cms .
#
# Next standalone output (`output: "standalone"` in next.config.mjs) emits a
# minimal server plus only the traced node_modules (incl. sharp). The cms
# build script runs `payload generate:importmap && payload generate:types`
# before `next build` - both artifacts are gitignored and generated in-image.

FROM node:24-alpine AS prune
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
COPY . .
RUN npx turbo@2 prune cms

FROM node:24-alpine AS build
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
COPY --from=prune /app/out .
RUN --mount=type=cache,target=/root/.npm npm ci
# Builds @xitter/* dependencies, generates the Payload import map + types,
# then `next build --turbopack`.
RUN npx turbo@2 run build --filter=cms

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# PORT is env-driven; 3457 is the local default (see @xitter/config).
ENV PORT=3457
COPY --from=build --chown=node:node /app/apps/cms/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/cms/.next/static ./apps/cms/.next/static
# Admin-panel brand mark (#143) - standalone output does not copy public/.
COPY --from=build --chown=node:node /app/apps/cms/public ./apps/cms/public
# Schema migrations for deployed environments: one self-contained runner
# (config + migrations + payload runtime compiled to plain JS by
# scripts/bundle-migrations.mjs). `npx payload migrate` cannot run here -
# production Next builds bundle payload into the server chunks, leaving no
# CLI, no tsx and no resolvable node_modules - and dev-mode schema push is
# deliberately off in deployed envs (payload.config.ts). The k8s migrate
# init container executes this before every start (migrate_command in
# infra/iac/environments/{dev,prod}/workloads.tf); see scripts/migrate.ts.
COPY --from=build --chown=node:node /app/apps/cms/.next/migrate ./apps/cms/.next/migrate
USER node
EXPOSE 3457
CMD ["node", "apps/cms/server.js"]
