/**
 * Stryker config - kept in TS so it stays lintable/typecheckable.
 * Run via `npm run mutate` in this workspace.
 *
 * No `excludeIntegrationTests` here: this package's tests are pure unit
 * tests over fakes (no testcontainers suites), so the default vitest
 * config runs as-is inside the sandbox.
 *
 * Exclusions beyond the shared factory defaults:
 * - `data/` is JSON seed content - the shared `src/**/*.ts` mutate globs
 *   never match it, so no explicit exclusion is needed.
 * - Shell-out glue and destructive entrypoints stay out of the sandbox:
 *   the docker compose/npm/mmdc wrappers (`lib/exec`, `lib/compose`,
 *   `docker`, `bootstrap`, `reset`, `diagrams`, `e2e-stack`) and the
 *   filesystem-wide `clean` entrypoint. They are exercised against the
 *   real stack (`deps:up`, `reset`, `docs:diagrams`, e2e webServer), not
 *   by unit tests, so mutants there would be pure NoCoverage noise with
 *   real side effects if ever executed.
 * - Untested infra clients (keycloak, rustfs, search-index, topics, env,
 *   openapi, bruno-check) stay IN the fold deliberately: their NoCoverage
 *   mutants are the visibility this package was missing (#90).
 */
import type { StrykerOptions } from '@stryker-mutator/core';
import { createStrykerConfig } from '@xitter/testing';

export default createStrykerConfig('scripts', {
  mutateExclude: [
    '!src/lib/exec.ts',
    '!src/lib/compose.ts',
    '!src/docker.ts',
    '!src/bootstrap.ts',
    '!src/reset.ts',
    '!src/clean.ts',
    '!src/diagrams.ts',
    '!src/e2e-stack.ts',
  ],
}) satisfies StrykerOptions;
