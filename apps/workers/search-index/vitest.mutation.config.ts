import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * Mutation-testing-only vitest config: integration suites (testcontainers
 * Kafka/OpenSearch) are excluded - they must not run inside the Stryker
 * sandbox (per-mutant container startup). Their correctness is asserted by
 * `turbo test` and e2e, which run them normally.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // #177: dot reporter - killed mutants stop printing full failure dumps
      // (Stryker's killed/survived accounting is the signal; dry-run
      // failures still abort loudly).
      reporters: ['dot'],
      exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
    },
  }),
);
