import { resetStatusSchema, type AdminHealth, type ResetStatus } from '@xitter/api-contracts';
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
 * dashboard points operators at where the metrics live: the local scrape
 * ports in dev (#132), the Grafana dashboards when deployed.
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

/** Grafana base URL is baked the same way (homelab instance, both envs). */
declare const __XITTER_GRAFANA_URL__: string;
export const grafanaUrl = __XITTER_GRAFANA_URL__;

/**
 * Dashboards that carry the workers' story (spec 06 required list). UIDs are
 * stable - the Tofu dashboard CRs pin them - so the panel can deep-link.
 */
export const WORKER_DASHBOARDS: { name: string; uid: string }[] = [
  { name: 'Kafka consumer lag', uid: 'xitter-kafka-lag' },
  { name: 'Feed freshness / lag', uid: 'xitter-feed-freshness' },
];

/**
 * Where each worker's metrics live in local dev. Rendered as copy, never as
 * links: the URLs are only addressable from the machine running the workers
 * (local dev), and through the edge they would be dead links (#132).
 */
export function workerScrapeTargets(): { name: string; localUrl: string }[] {
  return WORKER_METRICS.map((worker) => ({
    name: worker.name,
    localUrl: `http://localhost:${workerMetricsPorts[worker.name]}/metrics`,
  }));
}

/**
 * True when the panel is served through the deployed edge rather than local
 * dev (vite dev server / the local edge both serve from localhost). Deployed
 * hosts can reach the Grafana instance, so worker metrics become links;
 * locally the scrape-port copy is the honest rendering.
 */
export function isDeployedPanel(hostname: string = window.location.hostname): boolean {
  return !['localhost', '127.0.0.1', '[::1]'].includes(hostname.toLowerCase());
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

/**
 * Last reset/reseed run (admin-gated alias, #210 route pattern). Null = no
 * reset recorded (fresh env); the caller renders an empty state, not an
 * error. Response validated at the boundary like every panel fetch.
 */
export function fetchResetStatus(): Promise<ResetStatus | null> {
  return adminFetch<ResetStatus | null>('/api/feed/internal/admin/reset-status', {}, (value) =>
    resetStatusSchema.nullable().parse(value),
  );
}
