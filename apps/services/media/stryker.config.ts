/**
 * Stryker config - kept in TS so it stays lintable/typecheckable.
 * Run via `npm run mutate` in this workspace.
 */
import type { StrykerOptions } from '@stryker-mutator/core';
import { createStrykerConfig } from '@xitter/testing';

export default createStrykerConfig('service-media', {
  // Testcontainers suites (RustFS/Postgres) must not run inside the mutation
  // sandbox: each mutant pays full container startup. Mutation testing
  // targets pure logic; integration correctness is covered by the
  // integration suites themselves (turbo test) and e2e.
  excludeIntegrationTests: true,
}) satisfies StrykerOptions;
