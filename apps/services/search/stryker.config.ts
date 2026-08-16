/**
 * Stryker config - kept in TS so it stays lintable/typecheckable.
 * Run via `npm run mutate` in this workspace.
 */
import type { StrykerOptions } from '@stryker-mutator/core';
import { createStrykerConfig } from '@xitter/testing';

export default createStrykerConfig('service-search') satisfies StrykerOptions;
