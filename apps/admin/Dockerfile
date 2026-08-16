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
