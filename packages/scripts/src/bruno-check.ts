#!/usr/bin/env tsx
import { join } from 'node:path';
import { parseBrunoCollection } from './lib/bruno-parse.js';

/**
 * Parse-check the bruno collection (CI gate, `npm run lint:bruno`).
 * `bru run` aborts on the first unparseable .bru file, so a grammar error
 * silently disables the whole API smoke suite - this fails fast at PR time
 * instead of at the nightly.
 */
const collectionDir = join(process.cwd(), 'bruno', 'xitter');
const failures = parseBrunoCollection(collectionDir);
if (failures.length > 0) {
  for (const { file, error } of failures) {
    console.error(`✗ ${file}: ${error}`);
  }
  process.exit(1);
}
console.log(`bruno collection parses clean (${collectionDir})`);
