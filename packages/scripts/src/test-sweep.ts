#!/usr/bin/env tsx
/**
 * Manual orphan sweep (#47): remove labelled testcontainer leftovers from
 * interrupted runs. `npm run test:sweep [-- --age-min 30]`. Label- and
 * age-scoped exactly like the automatic sweeps - unlabelled resources are
 * never touched.
 */
import { DEFAULT_ORPHAN_AGE_MS, sweepOrphanedTestResources } from '@xitter/testing/sweep';

const DEFAULT_AGE_MIN = 30;

const ageIndex = process.argv.indexOf('--age-min');
const ageMin = ageIndex === -1 ? DEFAULT_AGE_MIN : Number(process.argv[ageIndex + 1]);
if (!Number.isFinite(ageMin) || ageMin < 0) {
  console.error('--age-min must be a non-negative number of minutes');
  process.exit(1);
}

try {
  const swept = await sweepOrphanedTestResources({
    minAgeMs: ageMin === DEFAULT_AGE_MIN ? DEFAULT_ORPHAN_AGE_MS : ageMin * 60_000,
  });
  const total = swept.containers + swept.networks + swept.volumes;
  console.log(
    `test:sweep removed ${total} orphaned test resource(s): ` +
      `${swept.containers} container(s), ${swept.networks} network(s), ${swept.volumes} volume(s) ` +
      `(age gate ${ageMin}min)`,
  );
} catch (err) {
  console.error(`test:sweep failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
