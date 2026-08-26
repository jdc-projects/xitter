import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config as parseDotenv, parse as parseDotenvToStrings } from 'dotenv';

export * from './ports.js';
export * from './schema.js';
export * from './service-env.js';
export * from './env-mode.js';
export * from './health-routes.js';
export * from './search-index.js';
export * from './valkey-keys.js';

/** Find the repo root by walking up from cwd (or the module itself) to package.json + turbo.json. */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = start;
  while (true) {
    const hasMarkers = [join(dir, 'package.json'), join(dir, 'turbo.json')].every((p) =>
      existsSync(p),
    );
    if (hasMarkers) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Could not find repo root above ${start}`);
    dir = parent;
  }
}

/** Load `<root>/.env` into process.env if present (does not override existing values). */
export function loadRepoEnv(): void {
  const envFile = join(findRepoRoot(), '.env');
  if (existsSync(envFile)) {
    parseDotenv({ path: envFile, quiet: true });
  }
}

/** Read `<root>/.env.example` (committed defaults) without touching process.env. */
export function readEnvExample(): Record<string, string> {
  const file = join(findRepoRoot(), '.env.example');
  const parsed = parseDotenvToStrings(readFileSync(file, 'utf8'));
  return parsed;
}
