/**
 * Shared Stryker mutation-testing defaults. Scope runs to the current workspace;
 * incremental mode + cached reports are configured per workspace via this factory.
 *
 * `excludeIntegrationTests`: testcontainers-based suites (*.integration.test.ts)
 * are excluded from the mutation run. They must never execute in the sandbox:
 * every mutant would pay full container startup, and the Kafka fixture's
 * machine-wide port lock serialises packages into an hours-long crawl (or an
 * apparent stall). Integration correctness is asserted by those suites in
 * `turbo test`; mutation testing targets pure logic.
 */
export function createStrykerConfig(
  projectName: string,
  options: { excludeIntegrationTests?: boolean } = {},
) {
  return {
    $schema:
      'https://raw.githubusercontent.com/stryker-mutator/stryker-js/master/packages/api/schema/stryker-schema.json',
    packageManager: 'npm',
    testRunner: 'vitest',
    vitest: options.excludeIntegrationTests
      ? {
          // Related mode (--related) resolves tests from the module graph of
          // mutated files and ignores the mutation config's excludes -
          // integration suites leak back into the sandbox. Plain mode runs
          // exactly what vitest.mutation.config.ts selects.
          related: false,
          configFile: './vitest.mutation.config.ts',
        }
      : undefined,
    reporters: ['html', 'clear-text', 'progress'],
    htmlReporter: {
      fileName: `reports/mutation/${projectName}.html`,
    },
    incremental: true,
    incrementalFile: `reports/mutation/${projectName}.incr`,
    mutate: [
      'src/**/*.ts',
      '!src/**/*.test.ts',
      '!src/generated/**',
      '!src/main.ts',
      '!src/index.ts',
    ],
    coverageAnalysis: 'perTest',
  } as const;
}
