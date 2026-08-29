import { describe, expect, it } from 'vitest';
import { listComposeProjects, partitionStacks } from './stack-sweep.js';

/**
 * Docker-daemon integration. On a loaded CI runner (parallel suites with
 * testcontainers) the docker CLI can queue for many seconds, so the whole
 * check runs as ONE test with a generous budget rather than three
 * five-second slots. Without a daemon every call degrades to empty/[] and
 * the invariants hold trivially.
 */
describe('stack partitioning (#175)', () => {
  it(
    'partitions every project exclusively; stale implies xitter-prefixed and running',
    { timeout: 60_000 },
    async () => {
      const projects = await listComposeProjects();
      expect(Array.isArray(projects)).toBe(true);

      const result = await partitionStacks('xitter-none');
      const staleNames = new Set(result.stale.map((p) => p.name));
      expect(result.stale.length + result.live.length).toBe(projects.length);
      for (const project of result.live) {
        expect(staleNames.has(project.name)).toBe(false);
      }
      for (const project of result.stale) {
        expect(project.name.startsWith('xitter-')).toBe(true);
        expect(project.name).not.toBe('xitter-none');
        expect(/running/i.test(project.status)).toBe(true);
      }
    },
  );
});
