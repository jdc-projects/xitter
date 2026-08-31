# syntax=docker/dockerfile:1
# admin (Refine/Vite SPA) image. Build from the repo root:
#   docker build -f apps/admin/Dockerfile -t xitter-admin .
#
# `vite build` emits static files; Caddy serves them with an SPA fallback and
# strips the /admin/ path prefix (the app is built with base '/admin/').

FROM node:24-alpine AS prune
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
COPY . .
RUN npx turbo@2 prune admin

FROM node:24-alpine AS build
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1
# IdP coordinates for the SPA, baked into the bundle by vite define at build
# time (apps/admin/src/env.ts - a static SPA has no runtime config). Deploy
# pipelines pass these as build-args; when absent the build keeps the local
# localhost fallbacks, so `npm run dev` and a plain docker build are unchanged.
ARG XITTER_KEYCLOAK_URL
ARG XITTER_ADMIN_REALM
ARG XITTER_ADMIN_CLIENT_ID
ENV XITTER_KEYCLOAK_URL=$XITTER_KEYCLOAK_URL \
    XITTER_ADMIN_REALM=$XITTER_ADMIN_REALM \
    XITTER_ADMIN_CLIENT_ID=$XITTER_ADMIN_CLIENT_ID
COPY --from=prune /app/out .
RUN --mount=type=cache,target=/root/.npm npm ci
# Builds @xitter/* dependencies, then `vite build` -> apps/admin/dist.
RUN npx turbo@2 run build --filter=admin

FROM caddy:2-alpine AS runtime
COPY apps/admin/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/admin/dist /srv
# Caddy ships with file capabilities on the binary (CAP_NET_BIND_SERVICE for
# :80/:443). Under Kubernetes' no-new-privileges + dropped capabilities,
# exec of a file-capabilities binary fails with "operation not permitted".
# We bind :8080 as an unprivileged user, so strip them.
RUN apk add --no-cache libcap \
  && setcap -r /usr/bin/caddy \
  && apk del libcap
# Caddy defaults to root; a static SPA needs neither root nor TLS.
RUN chown -R 1000:1000 /data /config /srv /etc/caddy
USER 1000
EXPOSE 8080
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
