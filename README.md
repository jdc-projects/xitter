# xitter

A Twitter/X-style demo application, built as a microservices showcase on a home
Kubernetes cluster. Everything here is disposable: **all data is reset nightly,
and nothing user-generated survives.** Do not enter personal or sensitive
information into any deployed environment.

## What's inside

| Area        | Tech                                                                       |
| ----------- | -------------------------------------------------------------------------- |
| Frontend    | Next.js 16 (App Router, SSR), Mantine 9, Tabler icons                       |
| CMS         | Payload 3 (site content, live preview)                                      |
| Admin       | Refine 5 + antd, one consolidated panel                                     |
| Services    | NestJS (Fastify) + Prisma 7: `social`, `posts`, `media`, `feed`, `search`   |
| Workers     | Node + Kafka (Knative): `fanout`, `media-process`, `search-index`           |
| Events      | Kafka, versioned topics, JSON envelope, zod contracts                       |
| Storage     | Postgres (per-service databases), RustFS, OpenSearch, Valkey                |
| Auth        | Keycloak (demo realm for users, homelab realm for admin), Cap.js captcha    |
| Infra       | OpenTofu, Kubernetes (homelab), Traefik path-based routing                  |
| Testing     | Vitest, Playwright (web + e2e), axe-core, Artillery, Stryker, Bruno         |

## Getting started

Requirements: Node 24 ([nvm](https://github.com/nvm-sh/nvm) uses `.nvmrc`),
Docker, npm.

```bash
cp .env.example .env   # adjust XITTER_ENV / XITTER_PORT_OFFSET for parallel copies
npm install
npm run deps:up        # docker dependencies (postgres, kafka, keycloak, ...)
npm run bootstrap      # topics + keycloak realms + db migrations
npm run dev            # everything, watch mode (prod-like: npm run build && npm run start)
```

The edge (Traefik) mirrors cluster routing at `http://localhost:8080` -
`/api/{service}`, `/media`, `/cms`, `/admin`. See `docs/runbooks/01-local-setup.md`
for the full walkthrough, and `npm run env:print` for resolved ports.

Demo accounts: `demo1` … `demo10`, password `DemoPass123!`.

## Documentation

Everything lives under [`docs/`](docs/README.md):

- [`docs/specs/`](docs/specs) - desired end-state specs (architecture, product,
  data, operations, testing)
- [`docs/decisions/`](docs/decisions) - immutable decision records
- [`docs/runbooks/`](docs/runbooks) - setup, deployment, content promotion

Agents working in this repo should read [`AGENTS.md`](AGENTS.md).

## Development

```bash
npm run check   # lint + typecheck + tests + build - green before any PR
npm run reset   # tear down and rebuild the local environment
npm run test:e2e # full-stack Playwright suite (auto-starts prod-like mode)
```

All changes go through PRs to `dev` (gitflow; `dev` -> release -> `prod`).
CI re-runs every gate. Branch protection expects `npm run check` to pass first.
