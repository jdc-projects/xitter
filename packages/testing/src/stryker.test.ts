import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createStrykerConfig } from './stryker.js';

/**
 * Walk up from the working directory (always the workspace root under both
 * vitest and turbo) to the directory holding turbo.json. `import.meta` is
 * not an option here: this package builds as CommonJS.
 */
function repoRoot(): string {
  let current = process.cwd();
  for (;;) {
    if (existsSync(join(current, 'turbo.json'))) return current;
    const parent = join(current, '..');
    if (parent === current) throw new Error(`turbo.json not found above ${process.cwd()}`);
    current = parent;
  }
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  workspaces?: string[];
}

interface Workspace {
  /** Directory name relative to the repo root (e.g. `apps/services/feed`). */
  rel: string;
  dir: string;
  pkg: PackageJson;
}

/**
 * Expand the root package.json's single-star workspace globs. Reading them
 * (instead of hardcoding `apps/*`, `packages/*`, ...) keeps the guard in
 * sync when workspaces are added or reorganised.
 */
function loadWorkspaces(): Workspace[] {
  const root = repoRoot();
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;
  const workspaces: Workspace[] = [];
  for (const glob of rootPkg.workspaces ?? []) {
    const prefix = /^([^*]+)\*$/.exec(glob)?.[1];
    if (prefix === undefined) continue;
    const parent = join(root, prefix);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const dir = join(parent, entry);
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) continue;
      workspaces.push({
        rel: dir.slice(root.length + 1),
        dir,
        pkg: JSON.parse(readFileSync(manifest, 'utf8')) as PackageJson,
      });
    }
  }
  return workspaces;
}

/** Does this workspace have testcontainers suites (`*.integration.test.ts`)? */
function hasIntegrationTests(dir: string): boolean {
  const src = join(dir, 'src');
  if (!existsSync(src)) return false;
  const walk = (current: string): boolean =>
    readdirSync(current, { withFileTypes: true }).some((entry) =>
      entry.isDirectory()
        ? walk(join(current, entry.name))
        : entry.name.endsWith('.integration.test.ts'),
    );
  return walk(src);
}

const MUTATING_WORKSPACES = loadWorkspaces().filter((ws) => ws.pkg.scripts?.mutate !== undefined);

describe('createStrykerConfig', () => {
  it('runs the default vitest config unless integration tests are excluded', () => {
    const plain = createStrykerConfig('demo');
    expect(plain.vitest).toBeUndefined();

    const excluded = createStrykerConfig('demo', { excludeIntegrationTests: true });
    expect(excluded.vitest).toEqual({
      related: false,
      configFile: './vitest.mutation.config.ts',
    });
  });

  it('appends extra mutate exclusions after the shared patterns', () => {
    const config = createStrykerConfig('demo', {
      mutateExclude: ['!src/entry.ts'],
    });
    expect(config.mutate.slice(-1)).toEqual(['!src/entry.ts']);
    expect(config.mutate[0]).toBe('src/**/*.ts');
  });

  it('passes the optional score floor through untouched', () => {
    expect(createStrykerConfig('demo').thresholds).toBeUndefined();
    expect(createStrykerConfig('demo', { thresholds: { break: 30 } }).thresholds).toEqual({
      break: 30,
    });
  });
});

describe('repo mutation configs', () => {
  /** Sanity for the walker itself: an empty result must never pass silently. */
  it('discovers the mutating workspaces from the root manifests', () => {
    const names = MUTATING_WORKSPACES.map((ws) => ws.rel).sort();
    expect(names).toContain('apps/services/feed');
    expect(names).toContain('packages/scripts');
    expect(names.length).toBeGreaterThanOrEqual(9);
  });

  /**
   * Guard for the `excludeIntegrationTests` convention: any workspace with
   * both a `mutate` task and testcontainers integration suites must keep
   * those suites out of the Stryker sandbox (feed regressed this once -
   * #125). The stryker config opts in AND the mutation vitest config it
   * points at must exist and exclude the suites.
   */
  it('excludes integration suites from every mutating workspace that has them', () => {
    const offenders = MUTATING_WORKSPACES.filter((ws) => hasIntegrationTests(ws.dir))
      .filter((ws) => {
        const strykerConfig = join(ws.dir, 'stryker.config.ts');
        if (!existsSync(strykerConfig)) return true;
        const source = readFileSync(strykerConfig, 'utf8');
        if (!/excludeIntegrationTests:\s*true/.test(source)) return true;
        const vitestMutation = join(ws.dir, 'vitest.mutation.config.ts');
        if (!existsSync(vitestMutation)) return true;
        return !readFileSync(vitestMutation, 'utf8').includes('*.integration.test.ts');
      })
      .map((ws) => ws.rel);

    expect(
      offenders,
      'Workspaces with a mutate task and *.integration.test.ts suites must set excludeIntegrationTests: true and exclude those suites in vitest.mutation.config.ts',
    ).toEqual([]);
  });
});
