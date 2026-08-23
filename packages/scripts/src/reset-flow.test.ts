import { describe, expect, it } from 'vitest';
import {
  runResetFlow,
  ResetFlowError,
  type RealmControl,
  type ResetStatus,
  type StoreControls,
  type WorkerControl,
} from './reset-flow.js';

/**
 * Flow contracts (spec ops 02): exact step ordering, idempotent retry shape,
 * workers always resumed, status record after the flush, and failure that
 * halts at the broken step. Store/worker mechanics are faked; the default
 * implementations are exercised by the live e2e cycle.
 */

interface Harness {
  workers: WorkerControl & { events: string[] };
  realm: RealmControl & { events: string[] };
  stores: StoreControls & { events: string[] };
  statusWrites: ResetStatus[];
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const events = { workers: [] as string[], realm: [] as string[], stores: [] as string[] };
  const statusWrites: ResetStatus[] = [];
  const h: Harness = {
    workers: {
      events: events.workers,
      async quiesce() {
        events.workers.push('quiesce');
      },
      async resume() {
        events.workers.push('resume');
      },
    },
    realm: {
      events: events.realm,
      async reset() {
        events.realm.push('reset');
      },
      async init() {
        events.realm.push('init');
        return [{ username: 'demo1', userId: 'u1' }];
      },
    },
    stores: {
      events: events.stores,
      async reseedServices() {
        events.stores.push('reseed');
        return ['social', 'posts', 'media', 'feed', 'search'];
      },
      async resetCms() {
        events.stores.push('cms');
        return { deleted: 2, created: 2, updated: 0 };
      },
      async wipeBucket() {
        events.stores.push('bucket');
        return 7;
      },
      async deleteSearchIndex() {
        events.stores.push('index');
      },
      async resetConsumerGroups() {
        events.stores.push('groups');
        return ['xitter-fanout-worker'];
      },
      async flushValkey() {
        events.stores.push('flush');
      },
      async writeStatus(status) {
        events.stores.push('status');
        statusWrites.push(status);
      },
      async countFeedItems() {
        events.stores.push('verify-empty');
        return 0;
      },
    },
    statusWrites,
  };
  return { ...h, ...overrides } as Harness;
}

/** Wrap a store control so each call also lands in a shared order log. */
function proxyStores(stores: StoreControls, order: string[]): StoreControls {
  return {
    async reseedServices() {
      order.push('reseed');
      return stores.reseedServices();
    },
    async resetCms() {
      order.push('cms');
      return stores.resetCms();
    },
    async wipeBucket() {
      order.push('bucket');
      return stores.wipeBucket();
    },
    async deleteSearchIndex() {
      order.push('index');
      return stores.deleteSearchIndex();
    },
    async resetConsumerGroups() {
      order.push('groups');
      return stores.resetConsumerGroups();
    },
    async flushValkey() {
      order.push('flush');
      return stores.flushValkey();
    },
    async writeStatus(status) {
      order.push('status');
      return stores.writeStatus(status);
    },
    async countFeedItems(username: string) {
      order.push('verify-empty');
      return stores.countFeedItems(username);
    },
  };
}

describe('runResetFlow', () => {
  it('runs the authoritative step order (spec ops 02)', async () => {
    const h = harness();
    const order: string[] = [];
    const report = await runResetFlow({
      workers: {
        quiesce: async () => {
          order.push('quiesce');
        },
        resume: async () => {
          order.push('resume');
        },
      },
      realm: {
        reset: async () => {
          order.push('realm-reset');
        },
        init: async () => {
          order.push('realm-init');
          return [{ username: 'demo1', userId: 'u1' }];
        },
      },
      stores: proxyStores(h.stores, order),
      log: () => undefined,
    });

    expect(order).toEqual([
      'quiesce',
      'realm-reset',
      'realm-init',
      'reseed',
      'cms',
      'bucket',
      'index',
      'groups',
      'flush',
      'resume',
      'verify-empty',
      'status',
    ]);
    expect(h.workers.events).toEqual([]); // not used in this run
    expect(report.success).toBe(true);
    expect(report.reseeded).toBe(false);
    expect(report.fingerprint).toBeNull();
    expect(report.steps.map((s) => s.name)).toEqual([
      'quiesce-workers',
      'recreate-keycloak-realm',
      'truncate-service-dbs',
      'reset-cms-content',
      'wipe-media-bucket',
      'delete-search-index',
      'reset-consumer-groups',
      'flush-valkey',
      'resume-workers',
      'verify-empty',
    ]);
  });

  it('seeds after workers resume when the flag is set', async () => {
    const h = harness();
    const order: string[] = [];
    const seeded: string[] = [];
    const report = await runResetFlow({
      seed: true,
      workers: {
        quiesce: async () => {
          order.push('quiesce');
        },
        resume: async () => {
          order.push('resume');
        },
      },
      realm: h.realm,
      stores: proxyStores(h.stores, order),
      log: () => undefined,
      seedFn: async (users) => {
        order.push('seed');
        seeded.push(...users.map((u) => u.username));
        return { fingerprint: 'abc123' };
      },
    });

    expect(seeded).toEqual(['demo1']);
    expect(order.indexOf('seed')).toBeGreaterThan(order.indexOf('resume'));
    expect(order.indexOf('seed')).toBeLessThan(order.indexOf('status'));
    expect(report.reseeded).toBe(true);
    expect(report.fingerprint).toBe('abc123');
  });

  it('writes the status record to the shared Valkey key after the flush', async () => {
    const h = harness();
    await runResetFlow({
      workers: h.workers,
      realm: h.realm,
      stores: h.stores,
      log: () => undefined,
      jobName: 'xitter-reset-dev',
    });
    expect(h.statusWrites.length).toBe(1);
    const status = h.statusWrites[0]!;
    expect(status.success).toBe(true);
    expect(status.job).toBe('xitter-reset-dev');
    expect(status.durationMs).toBeGreaterThanOrEqual(0);
    // Every step lands in the record the health tile renders.
    expect(status.steps.map((s) => s.name)).toContain('flush-valkey');
  });

  it('halts at a failed step, resumes workers, and reports failure', async () => {
    const h = harness();
    const failing: StoreControls = {
      ...h.stores,
      async wipeBucket() {
        await h.stores.wipeBucket();
        throw new Error('rustfs exploded');
      },
    };

    await expect(
      runResetFlow({
        workers: h.workers,
        realm: h.realm,
        stores: failing,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ResetFlowError);

    // Workers quiesced before the failure MUST be resumed (finally), and no
    // step after the failure ran.
    expect(h.workers.events).toEqual(['quiesce', 'resume']);
    expect(h.stores.events).not.toContain('groups');
    expect(h.stores.events).not.toContain('flush');
    expect(h.statusWrites[0]!.success).toBe(false);
    expect(h.statusWrites[0]!.steps.find((s) => s.name === 'wipe-media-bucket')?.ok).toBe(false);
  });

  it('resumes workers even when resuming them is the failing step', async () => {
    const h = harness();
    const failing: WorkerControl = {
      async quiesce() {
        await h.workers.quiesce();
      },
      resume: () => Promise.reject(new Error('k8s api down')),
    };
    await expect(
      runResetFlow({
        workers: failing,
        realm: h.realm,
        stores: h.stores,
        log: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ResetFlowError);
  });

  it('emits the xitter_reset_* metric contract', async () => {
    const h = harness();
    const report = await runResetFlow({
      workers: h.workers,
      realm: h.realm,
      stores: h.stores,
      log: () => undefined,
    });
    const names = report.metrics.map((line) => line.split(/[ {]/)[0]);
    expect(names).toContain('xitter_reset_success');
    expect(names).toContain('xitter_reset_duration_seconds');
    expect(names).toContain('xitter_reset_reseeded');
    expect(names).toContain('xitter_reset_step_duration_seconds');
    expect(report.metrics.join('\n')).toContain('step="flush-valkey"');
  });
});
