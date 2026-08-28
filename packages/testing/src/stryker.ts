/**
 * Shared Stryker mutation-testing defaults. Scope runs to the current workspace;
 * incremental mode + cached reports are configured per workspace via this factory.
 *
 * Log policy: `logLevel: 'warn'` plus a `clearTextReporter` limited to the score
 * table. Rationale: per-mutant diffs (clear-text) and INFO chatter flooded CI
 * logs, where GitHub renders every diff block like a job failure while real
 * errors stayed buried. `logLevel` alone is not enough - the clear-text reporter
 * writes surviving/NoCoverage diffs straight to stdout, not through the logger -
 * so `reportMutants`/`reportTests` are disabled too. What remains in the console:
 * the per-file score table at completion, the progress heartbeat (10s lines in
 * non-TTY CI), and anything logged at error/warn (dry-run test failures, config
 * errors). Per-mutant diffs live in the HTML/JSON artifacts under
 * `reports/mutation/`.
 *
 * `excludeIntegrationTests`: testcontainers-based suites (*.integration.test.ts)
 * are excluded from the mutation run. They must never execute in the sandbox:
 * every mutant would pay full container startup, and the Kafka fixture's
 * machine-wide port lock serialises packages into an hours-long crawl (or an
 * apparent stall). Integration correctness is asserted by those suites in
 * `turbo test`; mutation testing targets pure logic.
 *
 * `mutateExclude`: extra negate-globs appended to the shared mutate patterns
 * for non-service layouts (e.g. @xitter/scripts' docker/npm shell-out glue).
 */
export function createStrykerConfig(
  projectName: string,
  options: {
    excludeIntegrationTests?: boolean;
    mutateExclude?: string[];
    /** Score floor (`thresholds.break`); set from a measured baseline, never invented. */
    thresholds?: { break: number };
    /**
     * Per-run timeout for dry runs AND mutant runs (default 5000 + 1.5x
     * factor). Raise for suites with legitimately slow tests under
     * instrumentation - e.g. image rasterisation.
     */
    timeoutMS?: number;
  } = {},
) {
  return {
    $schema:
      'https://raw.githubusercontent.com/stryker-mutator/stryker-js/master/packages/api/schema/stryker-schema.json',
    packageManager: 'npm',
    testRunner: 'vitest',
    vitest: {
      // Every mutate workspace runs PLAIN mode on its vitest.mutation.config.ts
      // (the shape all packages already ran in CI). It carries the dot
      // reporter (#177): vitest's default reporter prints a full failure dump
      // for EVERY killed mutant - 1000+ stack-trace blocks per full-mutation
      // run, burying a genuine dry-run failure in identical noise. Stryker's
      // killed/survived accounting is the signal; dry-run failures still
      // abort loudly.
      //
      // Plain, not related: related mode narrows test files via the module
      // graph and (a) ignores the config's integration excludes, AND (b)
      // empirically breaks perTest mutant-coverage attribution in this
      // runner version (covered mutants all report NoCoverage - measured
      // 2026-08-28, score 38.25 -> 13.63 on @xitter/scripts).
      configFile: './vitest.mutation.config.ts',
      related: false,
    },
    logLevel: 'warn',
    reporters: ['clear-text', 'html', 'json', 'progress'],
    clearTextReporter: {
      reportMutants: false,
      reportTests: false,
    },
    htmlReporter: {
      fileName: `reports/mutation/${projectName}.html`,
    },
    jsonReporter: {
      fileName: `reports/mutation/${projectName}.json`,
    },
    incremental: true,
    timeoutMS: options.timeoutMS,
    incrementalFile: `reports/mutation/${projectName}.incr`,
    thresholds: options.thresholds,
    mutate: [
      'src/**/*.ts',
      '!src/**/*.test.ts',
      '!src/generated/**',
      '!src/main.ts',
      '!src/index.ts',
      ...(options.mutateExclude ?? []),
    ],
    coverageAnalysis: 'perTest',
  } as const;
}
