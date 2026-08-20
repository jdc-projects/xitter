import type { AdminHealth } from '@xitter/api-contracts';
import { adminFetch } from './admin-fetch.js';

/**
 * Aggregated health for the dashboard: every service exposes the same
 * admin-gated `internal/admin/health` (Terminus detail), fetched in
 * parallel client-side - each service stays the only authority on its own
 * dependencies (no cross-service fan-out server-side).
 *
 * Workers have no HTTP surface (metrics scrapes only), so the dashboard
 * renders them as links to their metrics endpoints (spec 03/06).
 */
const SERVICES = ['social', 'posts', 'media', 'feed', 'search'] as const;

export type ServiceName = (typeof SERVICES)[number];

export const WORKER_METRICS: { name: string }[] = [
  { name: 'fanout' },
  { name: 'media-process' },
  { name: 'search-index' },
];

/** Worker metrics links are baked at build (same mechanism as the IdP config). */
declare const __XITTER_WORKER_METRICS_PORTS__: Record<string, number>;
export const workerMetricsPorts: Record<string, number> = __XITTER_WORKER_METRICS_PORTS__;

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
