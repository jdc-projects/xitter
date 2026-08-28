import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

/**
 * Mutation-testing-only vitest config (#177): the dot reporter replaces the
 * default one so killed mutants stop printing full failure dumps (1000+ per
 * full-mutation run buried real signal). Normal `vitest run` is unchanged.
 * This package's tests are pure unit tests over fakes - no integration
 * excludes needed, so related-mode test selection stays enabled.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      // No integration excludes needed - pure unit suite. Dot reporter per #177.
      reporters: ['dot'],
    },
  }),
);
