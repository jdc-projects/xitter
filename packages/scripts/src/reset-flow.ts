#!/usr/bin/env tsx
/**
 * The nightly reset - the shared implementation behind BOTH the Kubernetes
 * CronJob (reset-job.ts) and local verification runs
 * (`npm run reset:live [--seed]`). Ordering is AUTHORITATIVE from
 * docs/specs/operations/02-data-reset.md (ADR 0010):
 *
 *   flush Valkey -> set the reset epoch -> wait for every worker to pause
 *   itself (heartbeat ack) -> recreate Keycloak demo realm -> truncate
 *   service DBs (+ CMS content) -> wipe RustFS bucket -> delete OpenSearch
 *   index -> clear the reset epoch (workers seek to the log end and
 *   resume) -> optional deterministic seed -> verify + report.
 *
 * Workers pause THEMSELVES on the epoch flag (packages/events
 * createResetEpochGate): nothing is scaled, no Kubernetes API is touched,
 * and the retained Kafka log is skipped by the workers' own
 * seek-to-the-end on resume instead of a consumer-group reset.
 *
 * Every step is idempotent: a retry (k8s backoffLimit) replays safely from
 * the top (the flush clears any stale epoch first, workers just keep
 * consuming until the new epoch appears). A failed step halts the run
 * after clearing the epoch, leaving the system in a safe (empty or
 * partially wiped) state with workers consuming again.
 */
import client from 'prom-client';
import {
  envInt,
  envString,
  loadRepoEnv,
  localUrl,
  RESET_EPOCH_KEY,
  RESET_STATUS_KEY,
  RESET_WORKERS,
  resetPausedKey,
} from '@xitter/config';
import { createJwtCache, realmUrls } from '@xitter/auth';
import { requestJson } from './lib/api.js';
import { keycloakBase, serviceBase, type ApiTarget } from './lib/targets.js';

const SERVICES: ApiTarget[] = ['social', 'posts', 'media', 'feed', 'search'];

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export interface RealmControl {
  reset(): Promise<void>;
  init(): Promise<Array<{ username: string; userId: string }>>;
}

export interface StoreControls {
  /** Per-service POST /internal/reseed (service token: svc-reset). */
  reseedServices(): Promise<string[]>;
  /** CMS content tables: delete all docs, re-apply committed files. */
  resetCms(): Promise<{ deleted: number; created: number; updated: number; skipped?: boolean }>;
  /** Empty the media bucket; returns objects deleted. */
  wipeBucket(): Promise<number>;
  /** Delete the OpenSearch posts index (recreated on the next event/boot). */
  deleteSearchIndex(): Promise<void>;
  /**
   * Wipe ephemeral Valkey state. Runs FIRST: it clears any stale epoch/
   * heartbeat state while workers are still live (harmless - they just
   * keep consuming until the new epoch appears).
   */
  flushValkey(): Promise<void>;
  /** Bump and publish the reset epoch; workers pause when they see it. */
  setResetEpoch(): Promise<number>;
  /** One poll: RESET_WORKERS whose heartbeat already matches the epoch. */
  workersPausedFor(epoch: number): Promise<string[]>;
  /**
   * Clear the epoch and every worker heartbeat - the workers' signal to
   * seek to the log end and resume consuming post-reset events.
   */
  clearResetEpoch(): Promise<void>;
  /** Persist the run record for the admin health tile (after the flush). */
  writeStatus(status: ResetStatus): Promise<void>;
  /** Zero-state check used when the reseed flag is off (spec: verification). */
  countFeedItems(username: string): Promise<number>;
}

export interface ResetStepReport {
  name: string;
  ok: boolean;
  durationMs: number;
  detail?: string;
}

export interface ResetStatus {
  job: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  success: boolean;
  reseeded: boolean;
  fingerprint: string | null;
  steps: ResetStepReport[];
}

export interface ResetReport extends ResetStatus {
  metrics: string[];
}

export interface ResetFlowOptions {
  seed?: boolean;
  log?: (message: string) => void;
  realm?: RealmControl;
  stores?: StoreControls;
  /** Overridable seed step (tests inject; default = packages/scripts seed). */
  seedFn?: (users: Array<{ username: string; userId: string }>) => Promise<{ fingerprint: string }>;
  /** Pushgateway URL; unset = emit metrics to the log only. */
  pushgatewayUrl?: string;
  jobName?: string;
  now?: () => number;
  /** Bounded wait for every worker's pause heartbeat (XITTER_RESET_PAUSE_TIMEOUT_MS). */
  pauseTimeoutMs?: number;
  /** Heartbeat poll cadence during that wait. */
  pausePollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export async function runResetFlow(options: ResetFlowOptions = {}): Promise<ResetReport> {
  loadRepoEnv();
  const log = options.log ?? console.log;
  const now = options.now ?? Date.now;
  const realm = options.realm ?? defaultRealmControl();
  const stores = options.stores ?? (await defaultStores());
  const startedAt = new Date(now()).toISOString();
  const steps: ResetStepReport[] = [];
  let epochActive = false;
  let fingerprint: string | null = null;

  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const startedStep = now();
    try {
      const result = await action();
      steps.push({
        name,
        ok: true,
        durationMs: now() - startedStep,
      });
      log(`reset: ${name} ok (${steps.at(-1)!.durationMs}ms)`);
      return result;
    } catch (err) {
      steps.push({
        name,
        ok: false,
        durationMs: now() - startedStep,
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  let success = false;
  try {
    // FIRST, before anything epoch-shaped: the flush clears stale epoch/
    // heartbeat state from any earlier (failed) run while workers are
    // still live and consuming - harmless by design.
    await step('flush-valkey', () => stores.flushValkey());

    const epoch = await step('set-reset-epoch', () => stores.setResetEpoch());
    steps.at(-1)!.detail = `epoch ${epoch}`;
    epochActive = true;

    await step('wait-workers-paused', async () => {
      const waiting = [...RESET_WORKERS];
      await waitFor(
        async () => {
          const paused = new Set(await stores.workersPausedFor(epoch));
          return waiting.filter((worker) => !paused.has(worker));
        },
        (pending) => {
          log(
            `reset: ${waiting.length - pending.length}/${waiting.length} worker(s) paused, waiting on ${pending.join(', ')}`,
          );
        },
        options.pauseTimeoutMs ?? envInt('XITTER_RESET_PAUSE_TIMEOUT_MS', 300_000),
        options.pausePollIntervalMs ?? 2_000,
        `workers did not acknowledge reset epoch ${epoch} within the pause timeout - aborting before any store is wiped`,
      );
      steps.at(-1)!.detail = [...RESET_WORKERS].join(', ');
    });

    const users = await step('recreate-keycloak-realm', async () => {
      await realm.reset();
      return realm.init();
    });

    await step('truncate-service-dbs', async () => {
      const reset = await stores.reseedServices();
      steps.at(-1)!.detail = reset.join(', ');
      return reset;
    });

    await step('reset-cms-content', async () => {
      const cms = await stores.resetCms();
      steps.at(-1)!.detail = cms.skipped
        ? 'skipped (XITTER_RESET_SKIP_CMS)'
        : `${cms.deleted} deleted, ${cms.created} created`;
    });

    await step('wipe-media-bucket', async () => {
      const deleted = await stores.wipeBucket();
      steps.at(-1)!.detail = `${deleted} objects`;
    });

    await step('delete-search-index', () => stores.deleteSearchIndex());

    await step('clear-reset-epoch', async () => {
      await stores.clearResetEpoch();
      epochActive = false;
    });

    if (options.seed) {
      const seedFn =
        options.seedFn ??
        (async (seedUsers) => {
          const { runSeed } = await import('./seed.js');
          return runSeed({ users: seedUsers.map((u) => ({ ...u })) });
        });
      fingerprint = (await step('seed', () => seedFn(users))).fingerprint;
    } else {
      await step('verify-empty', async () => {
        const items = await stores.countFeedItems('demo1');
        if (items !== 0) {
          throw new Error(`feed holds ${items} items after reset (expected 0)`);
        }
        steps.at(-1)!.detail = 'feed empty';
      });
    }

    success = true;
    return await finish();
  } catch (err) {
    log(
      `reset: FAILED after ${steps.filter((s) => s.ok).length} step(s) - ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return await finish();
  } finally {
    // Never leave workers paused on a failed run: an uncleared epoch is an
    // event blackhole (workers idle until the key goes away).
    if (epochActive) {
      await stores
        .clearResetEpoch()
        .catch((err) => log(`reset: clearing reset epoch failed: ${String(err)}`));
    }
  }

  async function finish(): Promise<ResetReport> {
    const finishedAt = new Date(now()).toISOString();
    const status: ResetStatus = {
      job: options.jobName ?? defaultJobName(),
      startedAt,
      finishedAt,
      durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
      success,
      reseeded: options.seed === true,
      fingerprint,
      steps,
    };
    // Status is best-effort: a Valkey outage must not mask the reset outcome.
    await stores
      .writeStatus(status)
      .catch((err) => log(`reset: status write failed: ${String(err)}`));
    const registry = buildRegistry(status);
    const metrics = (await registry.metrics()).split('\n').filter(Boolean);
    for (const line of metrics) log(line);
    const pushUrl = options.pushgatewayUrl ?? process.env.XITTER_RESET_PUSHGATEWAY_URL;
    if (pushUrl) {
      await new client.Pushgateway(pushUrl, {}, registry)
        .pushAdd({ jobName: status.job })
        .catch((err) => log(`reset: pushgateway push failed: ${String(err)}`));
    }
    if (!success) {
      const failure = steps.find((s) => !s.ok);
      throw new ResetFlowError(`reset failed at step: ${failure?.name ?? 'unknown'}`, status);
    }
    return { ...status, metrics };
  }
}

export class ResetFlowError extends Error {
  constructor(
    message: string,
    readonly report: ResetStatus,
  ) {
    super(message);
    this.name = 'ResetFlowError';
  }
}

// ---------------------------------------------------------------------------
// Metrics (xitter_reset_* - names are the contract with the T11 dashboards)
// ---------------------------------------------------------------------------

function buildRegistry(status: ResetStatus): client.Registry {
  const registry = new client.Registry();
  const labels = { job: status.job };
  new client.Gauge({
    name: 'xitter_reset_success',
    help: '1 when the most recent reset run completed all steps',
    registers: [registry],
    labelNames: ['job'],
  }).set(labels, status.success ? 1 : 0);
  new client.Gauge({
    name: 'xitter_reset_duration_seconds',
    help: 'Wall-clock duration of the most recent reset run',
    registers: [registry],
    labelNames: ['job'],
  }).set(labels, status.durationMs / 1000);
  new client.Gauge({
    name: 'xitter_reset_reseeded',
    help: '1 when the most recent reset run also applied the deterministic seed',
    registers: [registry],
    labelNames: ['job'],
  }).set(labels, status.reseeded ? 1 : 0);
  if (status.fingerprint) {
    // Content hash truncated to fit a label value; enough to spot drift.
    new client.Gauge({
      name: 'xitter_reset_seed_fingerprint_info',
      help: 'Deterministic seed corpus fingerprint (first 16 hex chars)',
      registers: [registry],
      labelNames: ['job', 'fingerprint'],
    }).set({ ...labels, fingerprint: status.fingerprint.slice(0, 16) }, 1);
  }
  const steps = new client.Gauge({
    name: 'xitter_reset_step_duration_seconds',
    help: 'Duration of each reset step (0 when the step did not run)',
    registers: [registry],
    labelNames: ['job', 'step', 'outcome'],
  });
  const seen = new Set<string>();
  for (const step of status.steps) {
    const key = `${step.name}:${step.ok ? 'ok' : 'failed'}`;
    if (seen.has(key)) continue; // retries append the same step name
    seen.add(key);
    steps.set(
      { job: status.job, step: step.name, outcome: step.ok ? 'ok' : 'failed' },
      step.durationMs / 1000,
    );
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Default controls (env-driven; the CronJob and local runs share them)
// ---------------------------------------------------------------------------

export function defaultJobName(): string {
  return envString('XITTER_RESET_JOB_NAME', `xitter-reset-${process.env.XITTER_ENV ?? 'local'}`);
}

/**
 * The env-driven realm control shared by the full reset (realm.reset +
 * realm.init) and the deploy-path `--ensure-users` mode (realm.init only) -
 * one code path for "the demo realm contract + users exist".
 */
export function defaultRealmControl(): RealmControl {
  return {
    async reset() {
      const { resetDemoRealm } = await import('./keycloak.js');
      await resetDemoRealm({ baseUrl: keycloakAdminBase() });
    },
    async init() {
      const { initDemoRealm } = await import('./keycloak.js');
      return initDemoRealm({
        baseUrl: keycloakAdminBase(),
        machineSecrets: machineSecrets(),
      });
    },
  };
}

function keycloakAdminBase(): string | undefined {
  return process.env.XITTER_SEED_KEYCLOAK_URL ?? process.env.KEYCLOAK_BASE_URL ?? undefined;
}

function machineSecrets(): Record<string, string> | undefined {
  const raw = process.env.XITTER_KEYCLOAK_MACHINE_SECRETS;
  if (!raw) return undefined;
  return JSON.parse(raw) as Record<string, string>;
}

async function defaultStores(): Promise<StoreControls> {
  const tokenUrl = realmUrls(keycloakBase(), envString('XITTER_DEMO_REALM', 'xitter-demo')).token;
  const resetToken = createJwtCache({
    tokenUrl,
    clientId: envString('XITTER_RESET_CLIENT_ID', 'svc-reset'),
    clientSecret: envString('XITTER_RESET_CLIENT_SECRET', 'svc-reset-local-secret'),
  });

  return {
    async reseedServices() {
      const done: string[] = [];
      for (const service of SERVICES) {
        // The svc-reset token is validated against realm keys that
        // Keycloak may still serve stale (old realm, just recreated) for a
        // beat - a 401 here is transient and clears within ~1s. Retry a
        // few times before failing the run; the call is idempotent.
        let lastError: unknown;
        for (let attempt = 1; attempt <= 4; attempt++) {
          try {
            await requestJson(
              serviceBase(service),
              `/api/${service}/internal/reseed`,
              { method: 'POST' },
              await resetToken.get(),
            );
            done.push(service);
            lastError = undefined;
            break;
          } catch (err) {
            lastError = err;
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          }
        }
        if (lastError) throw lastError;
      }
      return done;
    },

    async resetCms() {
      // Dev has no admin-realm CMS client wiring yet (T9 follow-up), so the
      // CronJob sets XITTER_RESET_SKIP_CMS=1 there; the step is an explicit,
      // visible skip rather than a silent one.
      if (process.env.XITTER_RESET_SKIP_CMS === '1') {
        return { deleted: 0, created: 0, updated: 0, skipped: true };
      }
      const { resetCmsContent } = await import('./content.js');
      return resetCmsContent();
    },

    async wipeBucket() {
      const { ListObjectsV2Command, DeleteObjectsCommand, S3Client } =
        await import('@aws-sdk/client-s3');
      const s3 = new S3Client({
        endpoint: process.env.XITTER_MEDIA_S3_ENDPOINT ?? localUrl('rustfs'),
        region: 'us-east-1',
        credentials: {
          accessKeyId: process.env.XITTER_MEDIA_S3_ACCESS_KEY ?? 'xitter-local',
          secretAccessKey: process.env.XITTER_MEDIA_S3_SECRET_KEY ?? 'xitter-local-secret',
        },
        forcePathStyle: true,
        requestChecksumCalculation: 'WHEN_REQUIRED' as const,
        responseChecksumValidation: 'WHEN_REQUIRED' as const,
      });
      const bucket = process.env.XITTER_MEDIA_S3_BUCKET ?? 'xitter-media';
      let deleted = 0;
      for (;;) {
        const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000 }));
        const keys = (listed.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((k) => k.Key);
        if (keys.length === 0) break;
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys } }));
        deleted += keys.length;
        if (!listed.IsTruncated) break;
      }
      return deleted;
    },

    async deleteSearchIndex() {
      const { POSTS_INDEX } = await import('@xitter/config');
      const { Client } = await import('@opensearch-project/opensearch');
      const { opensearchUrl } = await import('@xitter/config');
      const os = new Client({ node: opensearchUrl(), ssl: { rejectUnauthorized: false } });
      try {
        await os.indices.delete({ index: POSTS_INDEX });
      } catch (err) {
        const type = (err as { body?: { error?: { type?: string } } }).body?.error?.type;
        if (type !== 'index_not_found_exception') throw err;
      } finally {
        await os.close().catch(() => undefined);
      }
    },

    async flushValkey() {
      const redis = await connectResetValkey();
      try {
        await redis.flushall();
      } finally {
        await redis.quit().catch(() => undefined);
      }
    },

    async setResetEpoch() {
      const redis = await connectResetValkey<EpochValkeyLike>();
      try {
        // INCR, not SET: an epoch left behind by a crashed run (the flow's
        // flush normally clears it, but belt-and-braces) still yields a
        // value no live worker has acknowledged.
        return await redis.incr(RESET_EPOCH_KEY);
      } finally {
        await redis.quit().catch(() => undefined);
      }
    },

    async workersPausedFor(epoch) {
      const redis = await connectResetValkey<EpochValkeyLike>();
      try {
        const heartbeats = await redis.mget(
          ...RESET_WORKERS.map((worker) => resetPausedKey(worker)),
        );
        const epochValue = String(epoch);
        return RESET_WORKERS.filter((_, index) => heartbeats[index] === epochValue);
      } finally {
        await redis.quit().catch(() => undefined);
      }
    },

    async clearResetEpoch() {
      const redis = await connectResetValkey<EpochValkeyLike>();
      try {
        await redis.del(RESET_EPOCH_KEY, ...RESET_WORKERS.map((worker) => resetPausedKey(worker)));
      } finally {
        await redis.quit().catch(() => undefined);
      }
    },

    async writeStatus(status) {
      const redis = await connectResetValkey();
      try {
        await redis.set(RESET_STATUS_KEY, JSON.stringify(status));
      } finally {
        await redis.quit().catch(() => undefined);
      }
    },

    async countFeedItems(username: string) {
      // Unauthenticated zero-check via the seed's own login machinery: the
      // demo password grant exists exactly for scripts like this.
      const { PasswordGrant } = await import('./lib/targets.js');
      const grants = new PasswordGrant();
      const token = await grants.token(username);
      const feed = (await requestJson(
        serviceBase('feed'),
        '/api/feed/v1/feed?limit=50',
        { method: 'GET' },
        token,
      )) as { items?: unknown[] };
      return feed.items?.length ?? 0;
    },
  };
}

interface ValkeyLike {
  flushall(): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

interface EpochValkeyLike extends ValkeyLike {
  incr(key: string): Promise<number>;
  del(...keys: string[]): Promise<unknown>;
  mget(...keys: string[]): Promise<Array<string | null>>;
}

/** Connect to the reset's Valkey, typed as the caller's structural slice. */
async function connectResetValkey<T extends ValkeyLike = ValkeyLike>(): Promise<T> {
  const { valkeyUrl } = await import('@xitter/config');
  const { connectValkey } = await import('@xitter/observability');
  return connectValkey<T>({ url: process.env.VALKEY_URL ?? valkeyUrl() });
}

/**
 * Bounded poll loop for the worker-pause barrier. The reset must never
 * wipe a store while a worker is still consuming: on timeout this throws
 * BEFORE any store is touched, failing the run (alert) instead of risking
 * half-processed events.
 */
async function waitFor(
  probe: () => Promise<string[]>,
  onProgress: (pending: string[]) => void,
  timeoutMs: number,
  intervalMs: number,
  timeoutMessage: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastPending = '';
  for (;;) {
    const pending = await probe();
    const signature = pending.join(',');
    if (pending.length === 0) return;
    if (signature !== lastPending) {
      lastPending = signature;
      onProgress(pending);
    }
    if (Date.now() > deadline) throw new Error(timeoutMessage);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// --- CLI: npm run reset:live [-- --seed] -------------------------------------
if (process.argv[1]?.endsWith('reset-flow.ts')) {
  const seed = process.argv.includes('--seed');
  const report = await runResetFlow({ seed });
  console.log(
    `reset complete in ${report.durationMs}ms (reseeded: ${report.reseeded}, fingerprint: ${report.fingerprint ?? '-'})`,
  );
}
