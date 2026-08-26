#!/usr/bin/env tsx
/**
 * Manual orphan sweep (#47): remove labelled testcontainer leftovers from
 * interrupted runs. `npm run test:sweep [-- --age-min 0]`. Label- and
 * age-scoped exactly like the automatic sweeps - unlabelled resources are
 * never touched. RUNNING containers keep the conservative 30-minute gate
 * unless --age-running-min says otherwise (they may belong to a live suite).
 */
import { DEFAULT_ORPHAN_AGE_MS, sweepOrphanedTestResources } from '@xitter/testing/sweep';

const DEFAULT_AGE_MIN = 30;

function ageArgMin(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${flag} must be a non-negative number of minutes`);
    process.exit(1);
  }
  return value;
}

const minAgeMs = ageArgMin('--age-min', DEFAULT_AGE_MIN) * 60_000;
const runningMinAgeMs = process.argv.includes('--age-running-min')
  ? ageArgMin('--age-running-min', DEFAULT_AGE_MIN) * 60_000
  : DEFAULT_ORPHAN_AGE_MS;

try {
  const swept = await sweepOrphanedTestResources({ minAgeMs, runningMinAgeMs });
  const total = swept.containers + swept.networks + swept.volumes;
  console.log(
    `test:sweep removed ${total} orphaned test resource(s): ` +
      `${swept.containers} container(s), ${swept.networks} network(s), ${swept.volumes} volume(s) ` +
      `(stopped gate ${Math.round(minAgeMs / 60_000)}min, running gate ${Math.round(runningMinAgeMs / 60_000)}min)`,
  );
} catch (err) {
  console.error(`test:sweep failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
