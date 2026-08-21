#!/usr/bin/env tsx
/**
 * The nightly reset - the shared implementation behind BOTH the Kubernetes
 * CronJob (reset-job.ts) and local verification runs
 * (`npm run reset:live [--seed]`). Ordering is AUTHORITATIVE from
 * docs/specs/operations/02-data-reset.md:
 *
 *   quiesce workers -> recreate Keycloak demo realm -> truncate service DBs
 *   (+ CMS content) -> wipe RustFS bucket -> delete OpenSearch index ->
 *   reset Kafka consumer groups -> flush Valkey -> resume workers ->
 *   optional deterministic seed -> verify + report.
 *
 * Every step is idempotent: a retry (k8s backoffLimit) replays safely from
 * the top. A failed step halts the run after attempting to resume workers,
 * leaving the system in a safe (empty or partially wiped) state.
 */
import client from 'prom-client';
import {
  envInt,
  envString,
  loadRepoEnv,
  localPort,
  localUrl,
  RESET_STATUS_KEY,
} from '@xitter/config';
import { createJwtCache, realmUrls } from '@xitter/auth';
import { ALL_TOPICS, CONSUMER_GROUPS } from '@xitter/events';
import { Kafka } from 'kafkajs';
import { requestJson } from './lib/api.js';
import { keycloakBase, serviceBase, type ApiTarget } from './lib/targets.js';

const SERVICES: ApiTarget[] = ['social', 'posts', 'media', 'feed', 'search'];

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/** How the flow stops/restarts event consumption before/after the wipe. */
export interface WorkerControl {
  quiesce(): Promise<void>;
  resume(): Promise<void>;
}

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
  /** Reset the worker consumer groups to the new epoch (log end). */
  resetConsumerGroups(): Promise<string[]>;
  flushValkey(): Promise<void>;
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
  workers?: WorkerControl;
  realm?: RealmControl;
  stores?: StoreControls;
  /** Overridable seed step (tests inject; default = packages/scripts seed). */
  seedFn?: (users: Array<{ username: string; userId: string }>) => Promise<{ fingerprint: string }>;
  /** Pushgateway URL; unset = emit metrics to the log only. */
  pushgatewayUrl?: string;
  jobName?: string;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export async function runResetFlow(options: ResetFlowOptions = {}): Promise<ResetReport> {
  loadRepoEnv();
  const log = options.log ?? console.log;
  const now = options.now ?? Date.now;
  const workers = options.workers ?? localWorkerControl(log);
  const realm = options.realm ?? defaultRealmControl();
  const stores = options.stores ?? (await defaultStores());
  const startedAt = new Date(now()).toISOString();
  const steps: ResetStepReport[] = [];
  let quiesced = false;
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
    await step('quiesce-workers', async () => {
      await workers.quiesce();
      quiesced = true;
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

    await step('reset-consumer-groups', async () => {
      const groups = await stores.resetConsumerGroups();
      steps.at(-1)!.detail = groups.length ? groups.join(', ') : 'none active';
    });

    await step('flush-valkey', () => stores.flushValkey());

    await step('resume-workers', async () => {
      await workers.resume();
      quiesced = false;
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
    // Never leave workers scaled to zero on a failed run - the alert fires
    // either way, but the platform should keep consuming what exists.
    if (quiesced) {
      await workers.resume().catch((err) => log(`reset: resume failed: ${String(err)}`));
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

function defaultRealmControl(): RealmControl {
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
      const token = await resetToken.get();
      const done: string[] = [];
      for (const service of SERVICES) {
        await requestJson(
          serviceBase(service),
          `/api/${service}/internal/reseed`,
          { method: 'POST' },
          token,
        );
        done.push(service);
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

    async resetConsumerGroups() {
      const { kafkaBrokers } = await import('@xitter/config');
      const kafka = new Kafka({
        clientId: `xitter-reset-${process.env.XITTER_ENV ?? 'local'}`,
        brokers: (process.env.KAFKA_BROKERS ?? kafkaBrokers()).split(','),
      });
      const admin = kafka.admin();
      await admin.connect();
      try {
        const wanted = Object.values(CONSUMER_GROUPS);
        const existing = new Set((await admin.listGroups()).groups.map((g) => g.groupId));
        const targets = wanted.filter((g) => existing.has(g));
        if (targets.length > 0) {
          await waitForGroupsEmpty(admin, targets, logDrainDeadline());
        }

        // New epoch = new topic instances. kafkajs admin.resetOffsets does
        // NOT durably commit against Kafka 4 (verified: fetchOffsets reads
        // -1 right after a "successful" reset), so pinning group offsets at
        // the log end is not achievable that way. Deleting and recreating
        // the topics empties the log instead - the drained groups are then
        // deleted too, and the resumed workers (fromBeginning) replay only
        // post-reset events on the fresh log. Verified by offsets at 0.
        const existingTopics = (await admin.listTopics()).filter((t) =>
          (ALL_TOPICS as readonly string[]).includes(t),
        );
        if (existingTopics.length > 0) {
          await admin.deleteTopics({ topics: existingTopics });
        }
        const { ensureTopics } = await import('./topics.js');
        await ensureTopics(kafka);
        const stillExisting = new Set((await admin.listGroups()).groups.map((g) => g.groupId));
        const groups = targets.filter((g) => stillExisting.has(g));
        if (groups.length > 0) {
          await admin.deleteGroups(groups);
        }
        return [...existingTopics.map((t) => `topic:${t}`), ...groups.map((g) => `group:${g}`)];
      } finally {
        await admin.disconnect().catch(() => undefined);
      }
    },

    async flushValkey() {
      const { valkeyUrl } = await import('@xitter/config');
      const { connectValkey } = await import('@xitter/observability');
      const redis = await connectValkey<ValkeyLike>({ url: process.env.VALKEY_URL ?? valkeyUrl() });
      await redis.flushall();
      await redis.quit();
    },

    async writeStatus(status) {
      const { valkeyUrl } = await import('@xitter/config');
      const { connectValkey } = await import('@xitter/observability');
      const redis = await connectValkey<ValkeyLike>({ url: process.env.VALKEY_URL ?? valkeyUrl() });
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
interface AdminLike {
  describeGroups(
    groupIds: string[],
  ): Promise<{ groups: Array<{ state: string; members: unknown[] }> }>;
}

function logDrainDeadline(): number {
  return Date.now() + envInt('XITTER_RESET_GROUP_DRAIN_MS', 90_000);
}

/**
 * Kafka keeps a killed consumer's group membership until its session times
 * out (~30s with kafkajs defaults) - in-cluster scale-to-zero AND the local
 * SIGTERM quiesce both land here. AlterConsumerGroupOffsets is rejected
 * while any member is attached, so wait the sessions out (bounded).
 */
async function waitForGroupsEmpty(
  admin: AdminLike,
  groups: string[],
  deadline: number,
): Promise<void> {
  for (;;) {
    const described = (await admin.describeGroups(groups)).groups;
    const attached = described
      .map((group, index) => ({ name: groups[index], group }))
      .filter(({ group }) => group.members.length > 0 && group.state !== 'Dead');
    if (attached.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `consumer groups still have members after drain wait: ${attached.map((a) => a.name).join(', ')}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * Local worker control: the reset CLI runs where the workers are plain node
 * processes. A live reset (`reset:live`) needs them STOPPED while stores are
 * wiped (Kafka rejects group resets while members are attached), so quiesce
 * SIGTERMs the worker processes found on their metrics ports and resume
 * respawns them via `npm run start:workers`. Run the workers in their own
 * tree (`start:workers`) - killing workers inside a combined `npm run start`
 * makes that turbo exit and take the services with it. The volume twin
 * (`npm run reset`) never gets here: the whole stack is down already.
 */
export function localWorkerControl(log: (message: string) => void): WorkerControl {
  const ports = [
    localPort('fanoutMetrics'),
    localPort('mediaProcessMetrics'),
    localPort('searchIndexMetrics'),
  ];
  let stoppedAny = false;
  return {
    async quiesce() {
      const pidLists = await Promise.all(ports.map((port) => pidsOnPort(port)));
      const pids = [...new Set(pidLists.flat())];
      if (pids.length === 0) {
        log('reset: no local workers on their metrics ports (already quiesced)');
        return;
      }
      log(`reset: stopping ${pids.length} local worker process(es) for the wipe`);
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* raced exit - fine */
        }
      }
      const deadline = Date.now() + 15_000;
      const busy = async () =>
        (await Promise.all(ports.map((port) => portAnswers(port)))).filter(Boolean).length;
      while ((await busy()) > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      stoppedAny = true;
    },
    async resume() {
      if (!stoppedAny) return;
      stoppedAny = false;
      log('reset: restarting local workers (npm run start:workers)');
      const { spawn } = await import('node:child_process');
      const { findRepoRoot } = await import('@xitter/config');
      const child = spawn('npm', ['run', 'start:workers'], {
        cwd: findRepoRoot(),
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    },
  };
}

async function pidsOnPort(port: number): Promise<number[]> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runLsof = promisify(execFile) as (
    file: string,
    args: string[],
  ) => Promise<{ stdout: string }>;
  try {
    const { stdout } = await runLsof('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    return stdout
      .split('\n')
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isFinite(pid));
  } catch {
    return []; // lsof exits 1 when nothing listens
  }
}

async function portAnswers(port: number): Promise<boolean> {
  const { checkPort } = await import('./lib/port.js');
  return checkPort(port);
}

// --- CLI: npm run reset:live [-- --seed] -------------------------------------
if (process.argv[1]?.endsWith('reset-flow.ts')) {
  const seed = process.argv.includes('--seed');
  const report = await runResetFlow({ seed });
  console.log(
    `reset complete in ${report.durationMs}ms (reseeded: ${report.reseeded}, fingerprint: ${report.fingerprint ?? '-'})`,
  );
}
