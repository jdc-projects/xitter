import { describe, expect, it, vi } from 'vitest';

/**
 * Worker metrics pointers (#132) + the reset-status fetch: the health page
 * names where scrapes live instead of linking them (locally - the ports are
 * cluster-local, PodMonitor-scraped, never edge-routable, so a link only
 * ever worked from the operator's own machine) and reads the last reset
 * record through the admin-gated feed route. adminFetch is mocked to keep
 * the session/token path out of scope.
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

describe('fetchResetStatus', () => {
  it('calls the admin-gated feed route and parses at the boundary', async () => {
    const { adminFetch } = await import('./admin-fetch.js');
    const { fetchResetStatus } = await import('./health.js');
    const record = {
      job: 'xitter-reset',
      startedAt: '2026-08-30T00:30:00.000Z',
      finishedAt: '2026-08-30T00:30:42.000Z',
      durationMs: 42_000,
      success: true,
      reseeded: true,
      fingerprint: 'a'.repeat(64),
      steps: [{ name: 'flush-valkey', ok: true, durationMs: 12 }],
    };
    vi.mocked(adminFetch).mockResolvedValue(record);

    await expect(fetchResetStatus()).resolves.toEqual(record);
    expect(vi.mocked(adminFetch)).toHaveBeenCalledWith(
      '/api/feed/internal/admin/reset-status',
      {},
      expect.any(Function),
    );
    // The parse callback admits the documented record shape (and null).
    const parse = vi.mocked(adminFetch).mock.calls[0]![2]!;
    expect(parse(record)).toEqual(record);
    expect(parse(null)).toBeNull();
  });

  it('rejects records that do not match the contract', async () => {
    const { adminFetch } = await import('./admin-fetch.js');
    const { fetchResetStatus } = await import('./health.js');
    vi.mocked(adminFetch).mockResolvedValue(null);
    await fetchResetStatus();

    const parse = vi.mocked(adminFetch).mock.calls.at(-1)![2] as (value: unknown) => unknown;
    expect(() => parse({ success: 'yes' })).toThrow();
  });
});

describe('isDeployedPanel', () => {
  it('treats loopback hostnames as local dev, everything else as deployed', async () => {
    const { isDeployedPanel } = await import('./health.js');
    expect(isDeployedPanel('localhost')).toBe(false);
    expect(isDeployedPanel('127.0.0.1')).toBe(false);
    expect(isDeployedPanel('[::1]')).toBe(false);
    expect(isDeployedPanel('xitter-dev.jd-chapman.dev')).toBe(true);
    expect(isDeployedPanel('xitter.jd-chapman.dev')).toBe(true);
    // The test environment itself serves from localhost.
    expect(isDeployedPanel()).toBe(false);
  });
});
