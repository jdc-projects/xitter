/**
 * Shared Stryker mutation-testing defaults. Scope runs to the current workspace;
 * incremental mode + cached reports are configured per workspace via this factory.
 */
export function createStrykerConfig(projectName: string) {
  return {
    "$schema": "https://raw.githubusercontent.com/stryker-mutator/stryker-js/master/packages/api/schema/stryker-schema.json",
    packageManager: "npm",
    testRunner: "vitest",
    reporters: ["html", "clear-text", "progress"],
    htmlReporter: {
      fileName: `reports/mutation/${projectName}.html`,
    },
    incremental: true,
    incrementalFile: `reports/mutation/${projectName}.incr`,
    mutate: ["src/**/*.ts", "!src/**/*.test.ts", "!src/generated/**", "!src/main.ts", "!src/index.ts"],
    coverageAnalysis: "perTest",
  } as const;
}
