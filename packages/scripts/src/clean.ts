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

for (const target of targets) {
  const base = join(root, target);
  if (!existsSync(base)) continue;
  for (const workspace of readdirSync(base, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue;
    const dir = join(base, workspace.name);
    const sub = join(dir, workspace.name); // nested: apps/services/social, apps/workers/*
    const dirs = existsSync(sub) ? [dir, sub] : [dir];
    for (const d of dirs) {
      for (const artifact of ['.turbo', 'dist', 'coverage', 'reports', 'mutation']) {
        remove(join(d, artifact));
      }
      if (existsSync(d)) {
        for (const f of readdirSync(d)) {
          if (f.endsWith('.tsbuildinfo')) rmSync(join(d, f), { force: true });
        }
      }
    }
  }
}

// Next.js builds
for (const app of ['web', 'cms']) {
  remove(join(root, 'apps', app, '.next'));
}

console.log('clean: removed .turbo, dist, .next, coverage, tsbuildinfo, test reports');
