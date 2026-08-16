# Testing Specs

Desired end-state for how xitter is tested: strategy, suites, and quality gates.

| Doc                                                  | Purpose                                                              |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| [01-strategy.md](01-strategy.md)                     | Philosophy, test targets, pyramid, suite ownership, flakiness policy |
| [02-suites.md](02-suites.md)                         | Per-suite detail: scope, how to run, conventions                     |
| [03-coverage-and-gates.md](03-coverage-and-gates.md) | Gate definitions, local-first policy, CI wiring, coverage guidance   |

## Suite overview

| Suite              | Tool       | Scope                                     | Runs against                                       | When                                                     |
| ------------------ | ---------- | ----------------------------------------- | -------------------------------------------------- | -------------------------------------------------------- |
| Unit + integration | Vitest     | Workspaces (colocated `src/**/*.test.ts`) | Source, no build (integration uses testcontainers) | Every PR / `npm run test`                                |
| Web UI             | Playwright | Frontend behaviour in isolation           | Prod-like web build (mocked APIs)                  | Every PR / `npm run test:web`                            |
| E2E                | Playwright | Full user flows incl. auth, a11y          | Full stack through edge at `localhost:8080`        | Every PR / `npm run test:e2e`                            |
| Load               | Artillery  | HTTP + browser flows                      | Prod-like locally or deployed envs                 | Pre-release / on demand / `npm run test:load`            |
| Mutation           | Stryker    | Per-workspace, turbo-scoped               | Source (vitest runner)                             | Scoped in PRs, full on merge to `dev` / `npm run mutate` |
| API smoke          | Bruno      | Key endpoints                             | Local or dev env                                   | Smoke + manual / `npm run test:api`                      |
