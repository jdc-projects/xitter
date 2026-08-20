import { defineConfig } from 'vitest/config';
import { stopAllTestContainers } from '@xitter/testing';

export default defineConfig({
  test: {
    globalTeardown: stopAllTestContainers,
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
