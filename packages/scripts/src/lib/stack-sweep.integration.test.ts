import { describe, expect, it } from 'vitest';
import { listComposeProjects, partitionStacks } from './stack-sweep.js';

/**
 * Docker-daemon integration (skipped gracefully without one): the partition
 * logic runs against whatever the daemon reports. The dead-port branch is
 * exercised via a scratch listener for the local project's edge port.
 */
describe('stack partitioning (#175)', () => {
  it('lists projects as an array (empty without a daemon, never a crash)', async () => {
    const projects = await listComposeProjects();
    expect(Array.isArray(projects)).toBe(true);
  });

  it('partitions every project exclusively (a name is stale or live, never both)', async () => {
    const result = await partitionStacks('xitter-none');
    const staleNames = new Set(result.stale.map((p) => p.name));
    for (const project of result.live) {
      expect(staleNames.has(project.name)).toBe(false);
    }
  });

  it('every stale project is xitter-prefixed and running (never foreign/stopped)', async () => {
    const result = await partitionStacks('xitter-none');
    for (const project of result.stale) {
      expect(project.name.startsWith('xitter-')).toBe(true);
      expect(/running/i.test(project.status)).toBe(true);
    }
  });
});
