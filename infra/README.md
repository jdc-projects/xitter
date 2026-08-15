# infra

Everything that isn't application code and isn't cluster IaC:

- `docker/` - local dependency stack (compose + postgres init). One compose
  project per environment copy (see `packages/scripts/src/lib/compose.ts`).
- `proxy/` - local Traefik edge, mirroring the cluster's path-based routing.
  Dynamic routes are Go-templated on `XITTER_*_PORT` env vars.
- `iac/` - OpenTofu for the deployed environments (namespaces per env).

Run `npm run deps:up` / `deps:down` / `deps:status` from the repo root.
