import type { AdminHealth } from '@xitter/api-contracts';
import { adminFetch } from './admin-fetch.js';

/**
 * Aggregated health for the dashboard: every service exposes the same
 * admin-gated `internal/admin/health` (Terminus detail), fetched in
 * parallel client-side - each service stays the only authority on its own
 * dependencies (no cross-service fan-out server-side).
 *
 * Workers have no HTTP surface (metrics scrapes only). Those ports are
 * cluster-local by design - PodMonitor-scraped, no Service or edge route
 * (spec 06, and spec 07's "no inbound except metrics scrape") - so the
 * dashboard points operators at where the metrics live instead of linking
 * them: Grafana when deployed, the local scrape ports in dev (#132).
 */
const SERVICES = ['social', 'posts', 'media', 'feed', 'search'] as const;

type ServiceName = (typeof SERVICES)[number];

export const WORKER_METRICS: { name: string }[] = [
  { name: 'fanout' },
  { name: 'media-process' },
  { name: 'search-index' },
];

/** Worker metrics ports are baked at build (same mechanism as the IdP config). */
declare const __XITTER_WORKER_METRICS_PORTS__: Record<string, number>;
export const workerMetricsPorts: Record<string, number> = __XITTER_WORKER_METRICS_PORTS__;

/**
 * Where each worker's metrics live. Rendered as copy, never as links: the
 * URLs are only addressable from the machine running the workers (local
 * dev), and through the edge they would be dead links (#132).
 */
export function workerScrapeTargets(): { name: string; localUrl: string }[] {
  return WORKER_METRICS.map((worker) => ({
    name: worker.name,
    localUrl: `http://localhost:${workerMetricsPorts[worker.name]}/metrics`,
  }));
}

async function fetchServiceHealth(service: ServiceName): Promise<AdminHealth> {
  try {
    return await adminFetch<AdminHealth>(`/api/${service}/internal/admin/health`);
  } catch (err) {
    return {
      service,
      status: 'error',
      uptimeSeconds: 0,
      version: '-',
      checks: {
        api: {
          status: 'down',
          message: err instanceof Error ? err.message : 'unreachable',
        },
      },
    };
  }
}

export async function fetchAllServiceHealth(): Promise<AdminHealth[]> {
  return Promise.all(SERVICES.map((service) => fetchServiceHealth(service)));
}
