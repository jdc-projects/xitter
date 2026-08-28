# Suites

Per-suite detail. For philosophy and ownership see [01-strategy.md](01-strategy.md); for gates see [03-coverage-and-gates.md](03-coverage-and-gates.md).

## Vitest — unit + integration

| Aspect       | Detail                                                             |
| ------------ | ------------------------------------------------------------------ |
| Location     | Colocated `src/**/*.test.ts` per workspace                         |
| Runner       | `npm run test` (turbo-fan-out), `npm run test:watch` for iteration |
| Runs against | Source directly (tsx) — no build step                              |

- **Unit**: pure logic (domain rules, contract parsing, helper functions). Mocks are fine; mock collaborators, not the code under test.
- **Integration**: real service modules against **testcontainers** Postgres/Kafka via helpers from `@xitter/testing`. Real migrations applied; **per-test isolation** (fresh container or truncate between tests).
- No test touches a running dev server or shared local database.
- **Orphaned testcontainers** (#47): Ryuk cannot run on Podman-backed sockets, so interrupted/killed runs leak containers. Every fixture labels its containers `xitter.test.*` and sweeps fire on three triggers: suite start (vitest `globalSetup`, 30-minute age gate — see `@xitter/testing` `sweep.ts`), `npm run deps:down` (60s grace for stopped resources; running containers keep the 30-minute gate), and manual `npm run test:sweep`. A live suite also heartbeats an activity marker so aggressive sweeps stand down; only labelled resources are ever removed.

## Playwright — web (isolated frontend)

| Aspect   | Detail                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| Location | `tests/playwright/web`, config `webServer` auto-starts a prod-like web build                                |
| Scope    | Component behaviour, routing, rendering; API interaction via **mocked backend** (`page.route` interception) |
| Runs     | `npm run test:web`                                                                                          |

- Assertions target rendered output and user interaction, not network internals — mocks return realistic contract-shaped payloads.
- Includes visual sanity (layout renders, key elements visible) and basic a11y checks (landmarks, labels) beyond raw axe.
- **Viewport matrix (#151)**: every spec runs in three projects — `chromium` (1280×720), `mobile` (iPhone 13, 390×844) and `mobile-se` (iPhone SE, 375×667). Device emulation runs on Chromium (see [03-coverage-and-gates.md](03-coverage-and-gates.md) non-goals), sharing one `webServer` via `reuseExistingServer`.

## Playwright — e2e (full stack)

| Aspect   | Detail                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Location | `tests/playwright/e2e`; config `webServer` starts the full prod-like stack, exercised through the **edge proxy at `localhost:8080`** |
| Scope    | Real user journeys: login/auth, post creation, blocking, search, feed                                                                |
| Runs     | `npm run test:e2e`; a11y specs via `npm run test:a11y` (`@a11y` tag)                                                                 |

- Runs against **seeded known state** (deterministic seed), so flows assert on expected users/posts.
- Accessibility: axe-core scans in journey pages - public surfaces (incl. `/login` and the 404 in both signed-out and app-shell renders), authenticated app pages, and the admin panel; tags `wcag2a`, `wcag2aa`, `wcag21aa`, `wcag22aa`; **no serious or critical violations allowed**. The dormant-profile shell is out of reach on the reseeded stack (documented in the spec header; unit-tested instead).
- **Viewport matrix (#151)**: the core journey specs (`nav`, `feed-flow`, `post-flow`, `profile`, `search-flow`) re-run in the `mobile` project (iPhone 13, 390×844); `mobile-se` (iPhone SE, 375×667) carries the 320px-class geometry guard — `nav` + the overflow spec — rather than a second concurrent pass over the stateful flow specs (they share fixed demo accounts). `mobile.spec.ts` (mobile-only) holds the horizontal-overflow guard — `document.documentElement.scrollWidth` must not exceed the viewport — plus the fluid-search-box and stacked-profile-header guarantees, at both device widths. The axe set re-runs at iPhone 13 in `a11y-mobile` (where WCAG 2.5.8 target-size bites); the desktop-first admin panel is scanned by the desktop `a11y` project only (`admin-a11y.spec.ts`).

## Artillery — load

| Aspect   | Detail                                                                                                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Location | `tests/artillery`: `feed-flow.yml` (HTTP flows), `browser-flow.yml` (browser journeys via the Playwright engine), `processors.ts` (shared processor: demo-user rotation, password-grant token cache, browser flow functions) |
| Runs     | `npm run test:load` — both flows in sequence, exit-code gated; needs the prod-like stack (`deps:up` + `bootstrap`, like e2e). Absolute numbers for deployed envs come from the nightly (`-e deployed`)                       |
| Shape    | Phased load (warm-up → ramp) with a read-heavy mix (feed browse + post create), rotated across `demo1..demoN` so the per-user rate limiter sees spread load instead of throttling one user (#158)                            |
| Gating   | Budgets live in the configs (`ensure:` + the ensure plugin) and **fail the run**: breaches, error-rate excess, or a vacuous run (zero requests) exit non-zero — the suite cannot pass by doing nothing                       |

Thresholds (SLAs at target load — local budgets):

| Flow                      | Threshold                                                      |
| ------------------------- | -------------------------------------------------------------- |
| API endpoints (feed flow) | p95 < 150 ms · p99 < 400 ms · error rate < 1% · ≥ 200 requests |
| Pages (browser flow)      | per-page p95 < 1 s · error rate < 1%                           |

- The budgets are anchored to measured idle-stack baselines (API p95 ≈ 13 ms steady @5 rps, page p95 ≤ 55 ms): ~10× headroom for CI jitter while still catching 3–5× regressions. Tighten from measurements, never aspiration.
- The nightly deployed smoke runs the feed flow with WAN-scaled tripwire budgets (`environments.deployed` in `feed-flow.yml`); replace them with measured baselines once a few nightly reports exist. Browser budgets stay local until a deployed browser baseline is recorded.
- `config.target` reads `E2E_BASE_URL` via bare `$processEnvironment` lookup — the only interpolation Artillery supports there. `packages/scripts/src/load.ts` computes the offset-aware local URLs; deployed runs export `E2E_BASE_URL` directly.

Load runs never target dev mode and are excluded from per-PR gates ([03-coverage-and-gates.md](03-coverage-and-gates.md)); `npm run check:load` runs the suite on demand against a local stack. Nightly, a smoke run against the deployed dev environment publishes its report as a CI artifact ([../operations/04-release-pipeline.md](../operations/04-release-pipeline.md)).

## Stryker — mutation

| Aspect | Detail                                                                      |
| ------ | --------------------------------------------------------------------------- |
| Config | Per-workspace `stryker.config.ts` built from a factory in `@xitter/testing` |
| Runner | Vitest test runner against source                                           |
| Runs   | `npm run mutate`; scope with `npx turbo run mutate --filter=<workspace>`    |

- **Incremental mode** with cached reports under `reports/mutation/`.
- **Quiet console, rich artifacts**: `logLevel: warn` + clear-text reporter limited to the per-file score table — per-mutant diffs and test listings live in the HTML/JSON reports under `reports/mutation/`. Real errors (dry-run failures, config errors) still print at error/warn level and still fail the run.
- PRs run mutation only on **affected workspaces** (turbo filters); **full run on merge to `dev`**.
- Score expectations: aim high on domain/service logic; exclude skeleton files and `main` entrypoints via config ([03-coverage-and-gates.md](03-coverage-and-gates.md)).
- **In the fold**: all 8 apps, plus `@xitter/scripts` (reset/seed orchestration — excludes the docker/npm/mmdc shell-out glue and destructive entrypoints via the factory's `mutateExclude`; `data/` JSON never matches the src globs). Deliberately out: `@xitter/events` (declarative zod schemas — the registries' NoCoverage mutants in services were judged skip-worthy) and `apps/cms` (Payload 3 build; decision pending, not silent).
- **Integration suites stay out of the sandbox**: every workspace whose tests include `*.integration.test.ts` (testcontainers) must set `excludeIntegrationTests: true` (factory) and carry a `vitest.mutation.config.ts` excluding those suites — enforced by a unit test in `@xitter/testing` (`src/stryker.test.ts`) that walks all mutating workspaces.

## Bruno — API

| Aspect       | Detail                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| Location     | `bruno/xitter` collection: health, follow-user, create-post, get-feed, search-posts                              |
| Environments | `local` and `dev`                                                                                                |
| Runs         | `npm run test:api` (`bru run --env local`); `npm run test:api -- --env dev` against the deployed dev environment |

- Purpose: request-level smoke checks and manual API exploration; not a substitute for Vitest integration tests (no schema assertions, no isolation guarantees).
- Nightly, the collection runs against the freshly reseeded dev environment with the report published as a CI artifact ([../operations/04-release-pipeline.md](../operations/04-release-pipeline.md)).
