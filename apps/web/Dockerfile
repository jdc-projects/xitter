# syntax=docker/dockerfile:1
# web (Next.js) image. Build from the repo root (context = monorepo root):
#   docker build -f apps/web/Dockerfile -t xitter-web .
#
# Next standalone output (`output: "standalone"` in next.config.ts) emits a
# minimal server plus only the traced node_modules; the runtime stage is just
# that output plus the static assets.

FROM node:24-alpine AS prune
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
COPY . .
RUN npx turbo@2 prune web

FROM node:24-alpine AS build
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
COPY --from=prune /app/out .
RUN --mount=type=cache,target=/root/.npm npm ci
# Builds @xitter/* dependencies, then `next build --turbopack`.
RUN npx turbo@2 run build --filter=web

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
# PORT is env-driven; 3456 is the local default (see @xitter/config).
ENV PORT=3456
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
# Manifest brand icons (#143) - standalone output does not copy public/.
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 3456
CMD ["node", "apps/web/server.js"]
