#!/usr/bin/env tsx
/**
 * Deep-clean build state: turbo caches, build outputs, tsbuildinfo, test artifacts.
 * Run before trusting a local `npm run check` on a long-lived checkout -
 * stale dist/ + .turbo have masked real CI failures before.
 */
import { rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '@xitter/config';

const root = findRepoRoot();
const targets = ['apps', 'packages'];

const remove = (path: string): void => {
  rmSync(path, { recursive: true, force: true });
};

remove(join(root, '.turbo'));
remove(join(root, 'test-results'));
remove(join(root, 'tests/playwright/web/report'));
remove(join(root, 'tests/playwright/e2e/report'));

const cleanWorkspace = (dir: string): void => {
  for (const artifact of ['.turbo', 'dist', 'coverage', 'reports', 'mutation']) {
    remove(join(dir, artifact));
  }
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.tsbuildinfo')) rmSync(join(dir, f), { force: true });
  }
};

for (const target of targets) {
  const base = join(root, target);
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    cleanWorkspace(dir);
    // Nested workspaces: apps/services/*, apps/workers/*
    for (const nested of readdirSync(dir, { withFileTypes: true })) {
      if (!nested.isDirectory()) continue;
      const nestedDir = join(dir, nested.name);
      if (existsSync(join(nestedDir, 'package.json'))) cleanWorkspace(nestedDir);
    }
  }
}

// Next.js builds
for (const app of ['web', 'cms']) {
  remove(join(root, 'apps', app, '.next'));
}

console.log('clean: removed .turbo, dist, .next, coverage, tsbuildinfo, test reports');
