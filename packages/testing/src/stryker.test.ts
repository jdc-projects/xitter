import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createStrykerConfig } from './stryker.js';

/** This file lives at <root>/packages/testing/src - three hops to the root. */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

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
  const rootPkg = JSON.parse(
    readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as PackageJson;
  const workspaces: Workspace[] = [];
  for (const glob of rootPkg.workspaces ?? []) {
    const match = /^([^*]+)\*$/.exec(glob);
    if (!match) continue;
    const parent = join(REPO_ROOT, match[1]);
    if (!existsSync(parent)) continue;
    for (const entry of readdirSync(parent)) {
      const dir = join(parent, entry);
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) continue;
      workspaces.push({
        rel: dir.slice(REPO_ROOT.length + 1),
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
});

describe('repo mutation configs', () => {
  /**
   * Guard for the `excludeIntegrationTests` convention: any workspace with
   * both a `mutate` task and testcontainers integration suites must keep
   * those suites out of the Stryker sandbox (feed regressed this once -
   * #125). The stryker config opts in AND the mutation vitest config it
   * points at must exist and exclude the suites.
   */
  it('excludes integration suites from every mutating workspace that has them', () => {
    const offenders = loadWorkspaces()
      .filter(
        (ws) =>
          ws.pkg.scripts?.mutate !== undefined && hasIntegrationTests(ws.dir),
      )
      .filter((ws) => {
        const strykerConfig = join(ws.dir, 'stryker.config.ts');
        if (!existsSync(strykerConfig)) return true;
        const source = readFileSync(strykerConfig, 'utf8');
        if (!/excludeIntegrationTests:\s*true/.test(source)) return true;
        const vitestMutation = join(ws.dir, 'vitest.mutation.config.ts');
        if (!existsSync(vitestMutation)) return true;
        return !readFileSync(vitestMutation, 'utf8').includes(
          '*.integration.test.ts',
        );
      })
      .map((ws) => ws.rel);

    expect(
      offenders,
      'Workspaces with a mutate task and *.integration.test.ts suites must set excludeIntegrationTests: true and exclude those suites in vitest.mutation.config.ts',
    ).toEqual([]);
  });
});
