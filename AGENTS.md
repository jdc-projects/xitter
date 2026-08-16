# AGENTS.md

Guidance for AI agents (and humans) working in this repo. Keep this current.

## Project

xitter - a Twitter/X-style demo app built as a microservices showcase. Monorepo:
web frontend, CMS, admin panel, NestJS services, Kafka workers, shared packages,
local docker dependencies, OpenTofu IaC, and cross-app test suites. All data is
disposable and reset nightly; nothing here is precious except the code and docs.

Read first: `docs/README.md` (structure), `docs/specs/` (desired end-state),
`docs/decisions/` (why things are the way they are).

## Commands

| Task                      | Command                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Install                   | `npm install`                                                                                                      |
| All gates (run before PR) | `npm run check` (format + turbo lint/typecheck/test/build)                                                         |
| Repo analysis             | `npm run lint:repo` (fallow + react-doctor; requires `origin/dev` fetched)                                         |
| Everything CI runs on PR  | `npm run check:all` (`check` + repo analysis + scoped Stryker + web + e2e Playwright)                              |
| Deep-clean build state    | `npm run clean` - before trusting gates on a long-lived checkout                                                   |
| Dev (everything, watch)   | `npm run deps:up && npm run bootstrap && npm run dev`                                                              |
| Prod-like                 | `npm run build && npm run start`                                                                                   |
| Dependencies (docker)     | `npm run deps:up / deps:down / deps:status`                                                                        |
| Reset local env           | `npm run reset` (add nothing) / `npm run reset:reseed`                                                             |
| Tests                     | `npm run test` (unit+integration), `npm run test:web`, `npm run test:e2e`, `npm run test:load`, `npm run test:api` |
| Mutation testing          | `npm run mutate` (scoped: `npx turbo run mutate --filter=...`)                                                     |
| Repo-level lint           | `npm run lint:repo` (fallow + react-doctor)                                                                        |
| Format                    | `npm run format` / `npm run format:check`                                                                          |

Run gates locally before raising a PR; CI re-runs everything. `npm run check` (format,
turbo lint/typecheck/**Vitest test**/build) matches the CI `gates` job; `npm run lint:repo`
(fallow + react-doctor) matches `repo-analysis`. **`npm run check:all` is full CI parity**

- check + repo analysis + scoped Stryker (`check:mutation`, needs `origin/dev` fetched) +
  both Playwright suites - run it before any PR that changes tests, apps, or tooling.
  The e2e half needs the docker stack up (`npm run deps:up` first). Artillery + Bruno
  join `check:all` when their feature tickets (#13, #14) land. On a long-lived checkout
  run `npm run clean` first - stale `dist/` + turbo caches have masked real failures
  before. No automated suite runs against dev mode - unit/integration run against
  source, web/e2e/load against built artifacts.

## Architecture map

- `apps/web` - Next.js 16 (App Router, SSR) + Mantine 9 + Tabler icons.
- `apps/cms` - Payload 3 (site content only, live preview on).
- `apps/admin` - Refine 5 + antd (one consolidated admin panel).
- `apps/services/{social,posts,media,feed,search}` - NestJS (Fastify) + Prisma 7.
- `apps/workers/{fanout,media-process,search-index}` - Node + Kafka (Knative when deployed).
- `packages/*` - shared: api-contracts (zod + OpenAPI), api-client, auth, config,
  events, observability, testing, ui, scripts (local orchestration), tooling configs.
- `tests/playwright/{web,e2e}`, `tests/artillery` - cross-app suites.
- `bruno/` - API collection. `infra/` - docker, local Traefik, OpenTofu.

## Conventions and rules

- **Versioning**: APIs, events, and interfaces are versioned (`/v1`, topic `.v1`).
- **Package versions**: pin to major (`^16`), or minor for sub-1.0 (`^0.35`).
- **Ports/endpoints**: always env-driven via `@xitter/config` (`XITTER_*_PORT`,
  `XITTER_PORT_OFFSET`). Never hardcode a port or URL.
- **Storage ownership**: services own their data. No cross-service database
  access - go through APIs. Never add a shared Prisma schema.
- **Contracts**: request/response and event schemas live in `@xitter/api-contracts`
  and `@xitter/events` (zod). Consumers validate at the boundary.
- **Types**: TypeScript everywhere, strict, `tsc --noEmit` must pass. Scripts are TS (tsx).
- **Comments**: only where they add value - why, not what.
- **Styling**: Mantine props over CSS. Minimal CSS files.
- **Logging**: pino via `@xitter/observability`. Never log tokens or post bodies.
- **Secrets**: never commit. Local `.env` contains only non-secret defaults.
- **Docs**: update relevant specs in the same PR as behaviour changes. Decision
  records are immutable once on `dev`/`main` — supersede, don't edit (within an
  open PR, edit freely). Specs self-contained.
- **PRs**: vertical slices, all to `dev` (gitflow). Run `npm run check` first.
- **Libraries**: prefer well-supported libraries over custom code; check what's
  already in the repo before adding anything; check current versions rather
  than assuming.
- **Tests**: test features and outcomes, not implementation details. Colocated
  unit/integration tests (`src/**/*.test.ts`); cross-app suites under `tests/`.
- **Scaffolds**: many skeletons are intentionally thin - don't gold-plate them;
  feature tickets own the real implementation.

## Repo quirks

- Turborepo caches aggressively; if output looks stale, `npx turbo run clean` or
  remove `.turbo` directories.
- `src/generated/prisma` is generated output - never edit; run `npm run generate --workspace <service>`.
- The nightly reset is a feature, not an accident. Anything that must survive it
  belongs in the repo (seed content, Tofu, code).
- The About page is always called the "About page" (it contains an FAQ section,
  but is not a "FAQ page").
