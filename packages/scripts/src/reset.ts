#!/usr/bin/env tsx
/**
 * Local twin of the nightly reset: `tsx packages/scripts/src/reset.ts [--seed]`.
 *
 * Tears down every dependency volume and re-bootstraps - a superset of the
 * store-level wipe the deployed CronJob performs (docs/specs/operations/02):
 * nuking the volumes clears all service DBs, CMS, RustFS, OpenSearch, Kafka
 * and Valkey in one move, and taking the stack down IS the quiesce. Realm
 * setup, content files and the seed corpus are the exact code paths the
 * CronJob runs (keycloak.ts / content.ts / seed.ts via reset-flow.ts).
 *
 * With `--seed`: after bootstrap, waits for the app stack (if one is
 * running - `npm run dev`/`start` recover on their own once deps are back)
 * and applies the deterministic corpus. No stack running? The reset still
 * completes; run `npm run seed` once the stack is up.
 */
import { down, up } from './lib/compose.js';
import { run } from './lib/exec.js';

const seed = process.argv.includes('--seed');

console.log('tearing down (removing volumes)...');
await down(true);

console.log('starting dependencies...');
await up();

console.log('bootstrapping (bucket, topics, index, realms, schemas)...');
await run('tsx', ['packages/scripts/src/bootstrap.ts']);

if (seed) {
  const { seedWhenStackReady } = await import('./lib/seed-stack.js');
  await seedWhenStackReady();
}

console.log(seed ? 'reset complete (empty + reseeded)' : 'reset complete (empty)');
