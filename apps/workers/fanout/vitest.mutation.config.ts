import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * Mutation-testing-only vitest config: integration suites (testcontainers
 * Kafka) are excluded - they must not run inside the Stryker sandbox
 * (per-mutant container startup, and the Kafka fixture's machine-wide port
 * lock serialises packages). Their correctness is asserted by `turbo test`
 * and e2e, which run them normally.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
    },
  }),
);
