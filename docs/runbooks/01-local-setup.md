# Runbook 01: Local setup

## Context

Get a full local xitter environment running from a clean checkout. All third-party dependencies (Postgres, Kafka, OpenSearch, Valkey, RustFS, Keycloak, Traefik) run in docker via the compose stack (`infra/docker/compose.yaml`); app code runs on the host through turbo. Nothing here is precious — `npm run reset` wipes and re-creates everything.

## Execution steps

1. **Prerequisites**: Node 24 (`.nvmrc` → `nvm install && nvm use`), docker (running), npm.
2. `cp .env.example .env` — adjust `XITTER_ENV` and `XITTER_PORT_OFFSET` if you're running parallel copies of the stack (see docs/decisions/0009-local-dependency-isolation.md).
3. `npm install`
4. `npm run deps:up` — starts the docker dependency stack.
5. Either:
   - `npm run bootstrap` — waits for deps, then creates Kafka topics, inits Keycloak realms/users, and runs migrations, **or**
   - step-by-step: `npm run topics:create`, `npm run keycloak:init`, `npm run db:migrate`.
6. Optional: `npm run seed` — deterministic demo data.
7. Run the app:
   - Watch mode: `npm run dev`
   - Prod-like: `npm run build && npm run start`

Notes:

- `npm run env:print` shows the resolved ports for this checkout.
- The local edge (Traefik) is at the default `http://localhost:8080` — shift `XITTER_PORT_OFFSET` and everything (docker publishes, edge upstreams, apps, tests, seeding) moves together; a pinned `XITTER_*_PORT` env var is an absolute override and ignores the offset.
- Steps 5–6 are idempotent: topics already exist, realms already shaped, migrations already applied are no-ops.
- Parallel copies: `XITTER_ENV` + `XITTER_PORT_OFFSET` isolate everything orchestrated through the repo scripts (docker, apps, tests, seeding). Bruno and Artillery default to the zero-offset ports — export `XITTER_SEED_BASE_URL`/`XITTER_SEED_KEYCLOAK_URL` (Bruno: edit `bruno/xitter/environments/local.bru`) when targeting an offset copy.

## Validation steps

1. `curl http://localhost:8080/healthz` (adjust for offset) — edge responds.
2. Open `http://localhost:8080/` — landing page renders (public, static).
3. Log in with `demo1` / `DemoPass123!` — feed renders with seeded content.
4. `npm run deps:status` — all dependency containers healthy.
