import { mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Orphaned testcontainer sweeps (#47).
 *
 * Ryuk is disabled (see containers.ts - it dies on Podman-backed sockets),
 * so there is no reaper backstop: when a vitest run is killed hard, its
 * labelled containers (and any labelled networks/volumes, should fixtures
 * ever create them) persist until some LATER run happens to sweep them.
 * This module centralises the sweep so more triggers can fire it:
 *
 * - suite start - `sweepOrphansGlobalSetup` as vitest `globalSetup`,
 *   conservative 30-minute age gate only
 * - environment teardown - `npm run deps:down`: 60s grace for stopped
 *   resources; running containers keep the 30-minute gate (an interrupted
 *   run's orphans are usually still RUNNING - and so is a live suite's, so
 *   liveness alone cannot separate them and the gate must stay high). A
 *   fresh activity marker (live suite on this code) raises every gate to
 *   the conservative 30 minutes.
 * - manual - `npm run test:sweep` (age configurable via `--age-min`)
 *
 * Safety: only resources carrying a `xitter.test.*` label are ever
 * considered, and only when older than the caller's age gate - a live
 * suite's containers are necessarily younger. Unlabelled resources are
 * never touched, so nothing outside this repo's test fixtures is at risk.
 */

/** Every resource the fixtures label for sweeping carries this key prefix. */
export const TEST_RESOURCE_LABEL_PREFIX = 'xitter.test.';

/** Labels carried by the containers the fixtures start (single source of truth). */
export const POSTGRES_TEST_LABEL = `${TEST_RESOURCE_LABEL_PREFIX}postgres`;
export const KAFKA_TEST_LABEL = `${TEST_RESOURCE_LABEL_PREFIX}kafka`;
export const OPENSEARCH_TEST_LABEL = `${TEST_RESOURCE_LABEL_PREFIX}opensearch`;
export const RUSTFS_TEST_LABEL = `${TEST_RESOURCE_LABEL_PREFIX}rustfs`;
export const TEST_CONTAINER_LABELS = [
  POSTGRES_TEST_LABEL,
  KAFKA_TEST_LABEL,
  OPENSEARCH_TEST_LABEL,
  RUSTFS_TEST_LABEL,
] as const;

/**
 * Conservative age gate (suite start): comfortably longer than any service
 * suite run, so a live suite's container can never qualify as an orphan.
 */
export const DEFAULT_ORPHAN_AGE_MS = 30 * 60_000;

/** Environment-teardown grace (`deps:down`): nothing of ours should run then. */
export const ENV_TEARDOWN_GRACE_MS = 60_000;

/** A resource as reported by the docker list endpoints. */
export interface DockerResource {
  /** Container/network id, or volume name. */
  Id: string;
  /** Docker reports epoch seconds for containers, RFC3339 for networks/volumes. */
  Created: number | string;
  Labels?: Record<string, string> | null;
}

/** Normalise docker's inconsistent Created fields to epoch ms; null if unparseable. */
export function createdMs(created: number | string): number | null {
  if (typeof created === 'number') return created * 1000;
  const parsed = Date.parse(created);
  return Number.isNaN(parsed) ? null : parsed;
}

/** True only for resources labelled by this repo's test fixtures. */
export function hasTestResourceLabel(
  labels: Record<string, string> | null | undefined,
): boolean {
  return Object.keys(labels ?? {}).some((key) => key.startsWith(TEST_RESOURCE_LABEL_PREFIX));
}

/**
 * The orphan decision: label match AND age over the gate. Everything the
 * docker-facing sweeps delete goes through here, so this function is the
 * safety net that keeps unlabeled or too-young resources untouched.
 *
 * `runningMinAgeMs` gates resources whose liveness we cannot disprove -
 * RUNNING containers (an interrupted run's orphans are usually still
 * running, and so is a live suite's) and networks/volumes (no state field).
 * Callers that can prove nothing of ours is alive may lower it.
 */
export function selectOrphanResources<T extends DockerResource & { State?: string }>(
  resources: T[],
  nowMs: number,
  minAgeMs: number,
  runningMinAgeMs = minAgeMs,
): T[] {
  return resources.filter((resource) => {
    const createdAt = createdMs(resource.Created);
    if (createdAt === null || !hasTestResourceLabel(resource.Labels)) return false;
    const gate = resource.State === 'running' || resource.State === undefined ? runningMinAgeMs : minAgeMs;
    return createdAt <= nowMs - gate;
  });
}

// ---------------------------------------------------------------------------
// Suite activity markers - the concurrency guard for aggressive sweeps.
// ---------------------------------------------------------------------------

const ACTIVITY_STALE_MS = 60_000;
const ACTIVITY_HEARTBEAT_MS = 15_000;

function activityRoot(): string {
  return process.env.XITTER_TEST_ACTIVE_DIR ?? join(tmpdir(), 'xitter-test-active');
}

function activityMarkerDir(): string {
  return join(activityRoot(), String(process.pid));
}

/** Fresh marker = a suite demonstrably owns live test containers right now. */
export function isMarkerFresh(mtimeMs: number, nowMs: number, staleMs = ACTIVITY_STALE_MS): boolean {
  return nowMs - mtimeMs <= staleMs;
}

/**
 * True when any suite holds a fresh activity marker (see `ensureSuiteActivity`).
 * Fails closed - if the marker directory cannot be read, report active so
 * callers err towards NOT deleting aggressively.
 */
export function anySuiteActive(nowMs = Date.now()): boolean {
  let entries;
  try {
    entries = readdirSync(activityRoot(), { withFileTypes: true });
  } catch {
    return true;
  }
  let active = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const marker = join(activityRoot(), entry.name);
    try {
      if (isMarkerFresh(statSync(marker).mtimeMs, nowMs)) {
        active = true;
      } else {
        // Hard-killed runs leave stale markers behind; opportunistic removal.
        rmSync(marker, { recursive: true, force: true });
      }
    } catch {
      /* marker vanished mid-scan - ignore */
    }
  }
  return active;
}

let heartbeat: ReturnType<typeof setInterval> | undefined;

/**
 * Mark this process as owning live test containers: a per-pid marker
 * directory under the activity root, mtime-refreshed every 15s. Aggressive
 * sweeps (deps:down's short grace) check it and stand down while fresh. Best
 * effort throughout - the marker is advisory, never fatal.
 */
export function ensureSuiteActivity(): void {
  if (heartbeat) return;
  try {
    mkdirSync(activityMarkerDir(), { recursive: true });
    utimesSync(activityMarkerDir(), new Date(), new Date());
  } catch {
    return;
  }
  heartbeat = setInterval(() => {
    try {
      utimesSync(activityMarkerDir(), new Date(), new Date());
    } catch {
      /* dir removed underneath us - the next ensureSuiteActivity recreates */
    }
  }, ACTIVITY_HEARTBEAT_MS);
  heartbeat.unref();
}

/** Drop this process's activity marker (vitest globalTeardown / last untrack). */
export function endSuiteActivity(): void {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }
  try {
    rmSync(activityMarkerDir(), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Docker-socket sweep.
// ---------------------------------------------------------------------------

export interface SweepOptions {
  /** Minimum age (ms) for a stopped resource to qualify. Default 30 minutes. */
  minAgeMs?: number;
  /**
   * Minimum age (ms) for a RUNNING container (or state-less networks and
   * volumes) to qualify - liveness of a live suite cannot be disproven
   * without an activity marker, so this gate must stay conservative.
   * Defaults to `minAgeMs`.
   */
  runningMinAgeMs?: number;
  /**
   * Restrict the sweep to containers carrying one of these exact labels
   * (docker-side filter - the fixture-scoped startup sweeps). Networks and
   * volumes are only swept by the unrestricted form.
   */
  labels?: readonly string[];
}

export interface SweepResult {
  containers: number;
  networks: number;
  volumes: number;
}

function dockerSocketPath(): string {
  return process.env.DOCKER_HOST?.replace(/^unix:\/\//, '') ?? '/var/run/docker.sock';
}

async function dockerRequest(method: 'GET', path: string): Promise<unknown>;
async function dockerRequest(method: 'DELETE', path: string): Promise<void>;
async function dockerRequest(method: 'GET' | 'DELETE', path: string): Promise<unknown> {
  const http = await import('node:http');
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: dockerSocketPath(), path, method }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        if (method === 'DELETE') {
          // Removals are best effort (an in-use network/volume is skipped).
          resolve(undefined);
          return;
        }
        try {
          const parsed = JSON.parse(body) as unknown;
          if (res.statusCode !== 200) {
            reject(new Error(`docker ${path} failed (${res.statusCode}): ${body.slice(0, 80)}`));
            return;
          }
          resolve(parsed);
        } catch {
          reject(new Error(`docker ${path} returned non-JSON (${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function removeResources(ids: readonly string[], kind: 'containers' | 'networks' | 'volumes'): Promise<number> {
  await Promise.all(
    ids.map(async (id) => {
      const path =
        kind === 'volumes'
          ? `/volumes/${encodeURIComponent(id)}?force=true`
          : `/${kind}/${encodeURIComponent(id)}?force=true`;
      await dockerRequest('DELETE', path);
    }),
  );
  return ids.length;
}

/**
 * Remove orphaned (labelled + too old) test resources. Containers are always
 * swept; networks and volumes only in the unrestricted form - fixtures create
 * none today, this guards future ones. Throws on socket failure so callers
 * decide how loudly to fail; never touches unlabelled resources.
 */
export async function sweepOrphanedTestResources(options: SweepOptions = {}): Promise<SweepResult> {
  const minAgeMs = options.minAgeMs ?? DEFAULT_ORPHAN_AGE_MS;
  const runningMinAgeMs = options.runningMinAgeMs ?? minAgeMs;
  const now = Date.now();
  const labelFilter = options.labels
    ? `&filters=${encodeURIComponent(JSON.stringify({ label: [...options.labels] }))}`
    : '';

  const listed = (await dockerRequest(
    'GET',
    `/containers/json?all=1${labelFilter}`,
  )) as DockerResource[];
  const containers = selectOrphanResources(listed, now, minAgeMs, runningMinAgeMs);
  if (containers.length > 0) {
    process.stderr.write(
      `[test-sweep] removing ${containers.length} orphaned test container(s) older than ${Math.round(minAgeMs / 1000)}s (running gate ${Math.round(runningMinAgeMs / 1000)}s)\n`,
    );
  }
  const result: SweepResult = {
    containers: await removeResources(containers.map((c) => c.Id), 'containers'),
    networks: 0,
    volumes: 0,
  };

  if (options.labels) return result;

  // Unrestricted sweep: also catch labelled networks/volumes (containers/json
  // shape differs from /networks and /volumes, hence the per-endpoint mapping).
  // Networks and volumes carry no state - the conservative running gate applies.
  const networks = (await dockerRequest('GET', '/networks')) as DockerResource[];
  const orphanNetworks = selectOrphanResources(networks, now, minAgeMs, runningMinAgeMs);
  if (orphanNetworks.length > 0) {
    process.stderr.write(`[test-sweep] removing ${orphanNetworks.length} orphaned test network(s)\n`);
  }
  result.networks = await removeResources(orphanNetworks.map((n) => n.Id), 'networks');

  const volumeList = (await dockerRequest('GET', '/volumes')) as {
    Volumes?: (Omit<DockerResource, 'Id'> & { Name: string })[] | null;
  };
  const volumes = (volumeList?.Volumes ?? []).map((volume) => ({ ...volume, Id: volume.Name }));
  const orphanVolumes = selectOrphanResources(volumes, now, minAgeMs, runningMinAgeMs);
  if (orphanVolumes.length > 0) {
    process.stderr.write(`[test-sweep] removing ${orphanVolumes.length} orphaned test volume(s)\n`);
  }
  result.volumes = await removeResources(orphanVolumes.map((v) => v.Id), 'volumes');

  return result;
}

/**
 * Vitest `globalSetup`: eagerly sweep leftovers from interrupted runs before
 * a suite starts (conservative 30-minute gate - never races a live suite).
 * Failures are swallowed: a missing docker socket must not break unit-only
 * environments.
 */
export async function sweepOrphansGlobalSetup(): Promise<void> {
  await sweepOrphanedTestResources().catch(() => undefined);
}
