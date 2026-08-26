import { defineConfig } from 'vitest/config';
import { stopAllTestContainers } from '@xitter/testing';

export default defineConfig({
  test: {
    globalSetup: './vitest.global-setup.ts',
    globalTeardown: stopAllTestContainers,
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
