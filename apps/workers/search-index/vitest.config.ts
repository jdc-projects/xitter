import { defineConfig } from 'vitest/config';
import { stopAllTestContainers, sweepOrphansGlobalSetup } from '@xitter/testing';

export default defineConfig({
  test: {
    globalSetup: sweepOrphansGlobalSetup,
    globalTeardown: stopAllTestContainers,
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
