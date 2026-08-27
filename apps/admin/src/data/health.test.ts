import { describe, expect, it, vi } from 'vitest';

/**
 * Worker metrics pointers (#132): the health page names where scrapes live
 * instead of linking them - the ports are cluster-local (PodMonitor-scraped,
 * never edge-routable), so a link only ever worked from the operator's own
 * machine. adminFetch is mocked to keep the session/token path out of scope.
 */
vi.mock('./admin-fetch.js', () => ({ adminFetch: vi.fn() }));

describe('workerScrapeTargets', () => {
  it('covers every worker with a local scrape URL on its baked port', async () => {
    const { WORKER_METRICS, workerMetricsPorts, workerScrapeTargets } = await import('./health.js');
    const targets = workerScrapeTargets();
    expect(targets.map((target) => target.name)).toEqual(
      WORKER_METRICS.map((worker) => worker.name),
    );
    for (const target of targets) {
      expect(target.localUrl).toBe(`http://localhost:${workerMetricsPorts[target.name]}/metrics`);
    }
  });

  it('derives URLs from the build-time port map, never hardcoded ports', async () => {
    const { WORKER_METRICS, workerMetricsPorts, workerScrapeTargets } = await import('./health.js');
    expect(Object.keys(workerMetricsPorts).sort()).toEqual(
      [...WORKER_METRICS.map((worker) => worker.name)].sort(),
    );
    for (const target of workerScrapeTargets()) {
      // Localhost by definition: no URL here is addressable through the edge.
      expect(target.localUrl).toMatch(/^http:\/\/localhost:\d+\/metrics$/);
    }
  });
});
