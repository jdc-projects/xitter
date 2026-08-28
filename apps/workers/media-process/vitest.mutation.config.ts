import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * Mutation-testing-only vitest config (#177): the dot reporter replaces the
 * default one so killed mutants stop printing full failure dumps. Normal
 * `vitest run` is unchanged. No integration excludes (unit suite only), so
 * related-mode test selection stays enabled.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      reporters: ['dot'],
    },
  }),
);
