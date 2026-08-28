# Coverage and Gates

## Gate definitions

| Gate               | What runs                                        | Command                             |
| ------------------ | ------------------------------------------------ | ----------------------------------- |
| Build              | `turbo run build` (all workspaces)               | part of `npm run check`             |
| Lint               | Per-workspace ESLint + `tsc --noEmit` typecheck  | `npm run lint`, `npm run typecheck` |
| Repo lint          | `fallow analyze` + `react-doctor check`          | `npm run lint:repo`                 |
| Unit + integration | Vitest per workspace                             | `npm run test`                      |
| Web UI             | Playwright web suite                             | `npm run test:web`                  |
| E2E + a11y         | Playwright e2e suite (incl. `@a11y` specs and the mobile viewport matrix, #151) | `npm run test:e2e` |
| Mutation (scoped)  | Stryker on affected workspaces via turbo filters | `npm run mutate -- --filter=...`    |
| Format             | `prettier --check .`                             | `npm run format:check`              |

All gates: `npm run check` = `format:check` + `build:packages` + `turbo run lint typecheck test build`. Repo lint (fallow + react-doctor), web/e2e Playwright, and scoped mutation are separate — `npm run check:all` is full CI parity.

## Local-first policy

Every gate must be green **locally before raising a PR**; CI re-runs the same gates rather than discovering issues first. Local runs use the same commands CI uses — no CI-only configuration.

## CI wiring

| Trigger             | Runs                                                                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR → `dev`          | Build, lint (incl. repo lint), typecheck, unit/integration, web + e2e, format check, **mutation scoped to affected workspaces** (turbo filters)                   |
| Merge to `dev`      | **Full mutation run** across all workspaces, then deploy to the dev environment                                                                                   |
| Merge to `prod`     | Release: semver tag, version-tagged images, prod tofu apply, reconciliation PR (see [../operations/04-release-pipeline.md](../operations/04-release-pipeline.md)) |
| Nightly (02:30 UTC) | Scheduled suites against the deployed dev env: Bruno API smoke + Artillery load smoke, run summaries as CI artifacts                                              |

Deployed environments are managed via OpenTofu per `docs/specs/operations/01-environments.md`.

Locally, `check:all` is full CI parity: `check:repo` (format + audit + gates + repo lint) + scoped mutation + **`check:api` (Bruno, against a running local stack)** + web + e2e Playwright.

## Coverage guidance

| Surface                                    | Expectation                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Domain packages (`@xitter/*` logic)        | High line + mutation coverage                                           |
| Service logic (NestJS services)            | High coverage: endpoints, queries, event handlers via integration tests |
| Workers                                    | Event-handling paths covered (integration, testcontainers Kafka)        |
| UI components                              | Interaction-tested via web suite; visual basics only                    |
| Config, skeleton files, `main`/entrypoints | **Exempt** — excluded from mutation configs, not counted                |

Determinism rules from [01-strategy.md](01-strategy.md) apply: fixed `now` for time logic, no wall-clock or sleep dependencies.

## Non-goals

- No cross-browser matrix — **Chromium only** in CI. The mobile viewport projects (#151) are iPhone-class **device emulation on Chromium** (viewport, touch, `isMobile`), not a WebKit engine addition - the rule holds.
- No visual regression suite initially — a future option if UI churn demands it; basic render assertions in the web suite cover the interim.
- No coverage-number enforcement that rewards string-checking config files — coverage is judged by value, not a threshold gate.
