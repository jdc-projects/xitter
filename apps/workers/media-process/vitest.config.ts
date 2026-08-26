import { defineConfig } from 'vitest/config';
import { sweepOrphansGlobalSetup } from '@xitter/testing';

export default defineConfig({
  test: {
    globalSetup: sweepOrphansGlobalSetup,
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    // container start/teardown under parallel turbo runs can far exceed the
    // 10s defaults (same values as the service configs)
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
