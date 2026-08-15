#!/usr/bin/env tsx
/**
 * Env utilities: `tsx packages/scripts/src/env.ts print|init`
 *  - print: resolved values for every XITTER_* variable (defaults + offset applied)
 *  - init: copy .env.example to .env if missing
 */
import { existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot, loadRepoEnv, localPort, portOffset } from '@xitter/config';

const command = process.argv[2] ?? 'print';
const root = findRepoRoot();
const envPath = join(root, '.env');

switch (command) {
  case 'init':
    if (!existsSync(envPath)) {
      copyFileSync(join(root, '.env.example'), envPath);
      console.log(`created ${envPath}`);
    } else {
      console.log(`${envPath} already exists`);
    }
    break;
  case 'print': {
    loadRepoEnv();
    console.log(`XITTER_ENV=${process.env.XITTER_ENV ?? 'local'} (offset ${portOffset()})`);
    const names = [
      'edge',
      'web',
      'cms',
      'admin',
      'social',
      'posts',
      'media',
      'feed',
      'search',
      'postgres',
      'kafka',
      'opensearch',
      'rustfs',
      'rustfsConsole',
      'valkey',
      'keycloak',
    ] as const;
    for (const name of names) {
      console.log(`${name.padEnd(14)} ${localPort(name)}`);
    }
    break;
  }
  default:
    console.error(`Unknown command: ${command}. Use init | print.`);
    process.exit(1);
}
