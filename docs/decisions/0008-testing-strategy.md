# ADR 0008: Testing strategy

## Status

Decided — 2026-08-15

## Context

Testing is a first-class citizen of this repo, with specific suites required: unit/integration, web UI tests, full-stack e2e, accessibility, load, and mutation testing. The choices need to work inside an npm-workspaces + Turborepo monorepo where gates run locally before every PR and again in CI.

## Decision

| Suite              | Tool                                         | Scope                                                                   |
| ------------------ | -------------------------------------------- | ----------------------------------------------------------------------- |
| Unit + integration | **Vitest**, colocated (`src/**/*.test.ts`)   | Integration tests use testcontainers where real dependencies are needed |
| Web                | **Playwright** (`tests/playwright/web`)      | Isolated, mocked backend                                                |
| E2e                | **Playwright** (`tests/playwright/e2e`)      | Full stack via the edge; auto-starts a prod-like stack                  |
| Accessibility      | **axe-core** in e2e, tagged `@a11y`          | Runs as part of the e2e suite                                           |
| Load               | **Artillery** (`tests/artillery`)            | Against a prod-like stack                                               |
| Mutation           | **Stryker**, incremental with cached reports | Scoped via turbo filters (`--filter=...`)                               |
| API                | **Bruno CLI** (`bruno/`)                     | Collection run against local env                                        |

Gates: `npm run check` (lint + typecheck + test + build) runs locally before a PR, then CI re-runs it. No automated suite runs against dev mode — unit/integration run against source; web/e2e/load run against built artifacts.

## Options

| Option                                                                       | Pros                                                                                  | Cons                                                                                                                                                | Verdict    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Jest                                                                         | Familiar, huge ecosystem                                                              | Slower; first-class TS/ESM support has historically lagged                                                                                          | Rejected   |
| Cypress for web/e2e                                                          | Good DX, real browser                                                                 | Playwright has better multi-context support (multi-user social flows need two authenticated contexts) and is already used for web-server management | Rejected   |
| Separate e2e repo                                                            | Isolation from app churn                                                              | Against the monorepo goal; version drift between suites and app code                                                                                | Rejected   |
| **Vitest + Playwright + Stryker + Artillery + axe, gated by check (chosen)** | Fast, TS-native, one workspace toolchain; mutation scoped affordably by turbo filters | Several tools to keep configured                                                                                                                    | **Chosen** |

## Consequences

- Test placement is conventional and discoverable: colocated unit/integration, cross-app suites under `tests/`.
- Multi-user flows (follow, feed, replies) are testable in one Playwright run via contexts — the killer feature that ruled out Cypress.
- Stryker runs are incremental and turbo-scoped to keep runtime tractable; full-repo mutation runs are opt-in.
- The e2e suite owning prod-like stack startup keeps it honest — it tests what will actually be deployed.
