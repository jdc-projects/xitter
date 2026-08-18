#!/usr/bin/env tsx
/**
 * Full local bootstrap after `deps:up`: wait for health, create Kafka topics,
 * initialise Keycloak realms, run migrations, optionally seed.
 */
import { run } from './lib/exec.js';
import { waitForDependencies } from './lib/wait.js';
import { initDemoRealm, initLocalAdminRealm } from './keycloak.js';

console.log('waiting for dependencies...');
await waitForDependencies();

console.log('creating Kafka topics...');
await run('tsx', ['packages/scripts/src/topics.ts', 'create']);

console.log('initialising Keycloak...');
await initDemoRealm();
await initLocalAdminRealm();

console.log('pushing schemas...');
await run('npm', ['run', 'db:push']);

if (process.argv.includes('--seed')) {
  console.log('seeding...');
  await run('tsx', ['packages/scripts/src/seed.ts']);
}

console.log('bootstrap complete');
