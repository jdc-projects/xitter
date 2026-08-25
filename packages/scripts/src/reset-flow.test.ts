import { describe, expect, it } from 'vitest';
import {
  runResetFlow,
  ResetFlowError,
  type RealmControl,
  type ResetStatus,
  type StoreControls,
} from './reset-flow.js';

/**
 * Flow contracts (spec ops 02, ADR 0010): exact step ordering (flush ->
 * epoch -> worker-pause barrier -> data steps -> clear epoch -> seed),
 * the epoch always cleared on failure, status record after the run, and
 * failure that halts at the broken step. Store mechanics are faked; the
 * default implementations are exercised by the live e2e cycle.
 */

interface Harness {
  realm: RealmControl & { events: string[] };
  stores: StoreControls & { events: string[] };
  statusWrites: ResetStatus[];
}

function harness(overrides: Partial<Harness> = {}): Harness {
  const events = { realm: [] as string[], stores: [] as string[] };
  const statusWrites: ResetStatus[] = [];
  const h: Harness = {
    realm: {
      events: events.realm,
      async reset() {
        events.realm.push('realm-reset');
      },
      async init() {
        events.realm.push('realm-init');
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
      async flushValkey() {
        events.stores.push('flush');
      },
      async setResetEpoch() {
        events.stores.push('set-epoch');
        return 41;
      },
      async workersPausedFor() {
        events.stores.push('workers-paused');
        return ['fanout', 'media-process', 'search-index'];
      },
      async clearResetEpoch() {
        events.stores.push('clear-epoch');
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
    async flushValkey() {
      order.push('flush');
      return stores.flushValkey();
    },
    async setResetEpoch() {
      order.push('set-epoch');
      return stores.setResetEpoch();
    },
    async workersPausedFor(epoch) {
      order.push('workers-paused');
      return stores.workersPausedFor(epoch);
    },
    async clearResetEpoch() {
      order.push('clear-epoch');
      return stores.clearResetEpoch();
    },
    async writeStatus(status) {
      order.push('status');
      return stores.writeStatus(status);
    },
    async countFeedItems(username) {
      order.push('verify-empty');
      return stores.countFeedItems(username);
    },
  };
}

describe('runResetFlow', () => {
  it('runs the authoritative step order (spec ops 02, ADR 0010)', async () => {
    const h = harness();
    const order: string[] = [];
    const report = await runResetFlow({
      realm: {
        reset: async () => {
          order.push('realm-reset');
          await h.realm.reset();
        },
        init: async () => {
          order.push('realm-init');
          return h.realm.init();
        },
      },
      stores: proxyStores(h.stores, order),
      log: () => undefined,
    });

    // The flush precedes everything (clears stale epoch state while the
    // workers are still live); the epoch barrier precedes every wipe; the
    // epoch clears before the seed so workers can consume seed events.
    expect(order).toEqual([
      'flush',
      'set-epoch',
      'workers-paused',
      'realm-reset',
      'realm-init',
      'reseed',
      'cms',
      'bucket',
      'index',
      'clear-epoch',
      'verify-empty',
      'status',
    ]);
    expect(report.success).toBe(true);
    expect(report.reseeded).toBe(false);
    expect(report.fingerprint).toBeNull();
    expect(report.steps.map((s) => s.name)).toEqual([
      'flush-valkey',
      'set-reset-epoch',
      'wait-workers-paused',
      'recreate-keycloak-realm',
      'truncate-service-dbs',
      'reset-cms-content',
      'wipe-media-bucket',
      'delete-search-index',
      'clear-reset-epoch',
      'verify-empty',
    ]);
  });

  it('seeds after the epoch clears when the flag is set', async () => {
    const h = harness();
    const order: string[] = [];
    const seeded: string[] = [];
    const report = await runResetFlow({
      seed: true,
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
    expect(order.indexOf('seed')).toBeGreaterThan(order.indexOf('clear-epoch'));
    expect(order.indexOf('seed')).toBeLessThan(order.indexOf('status'));
    expect(report.reseeded).toBe(true);
    expect(report.fingerprint).toBe('abc123');
  });

  it('waits for the epoch to be acknowledged by every worker before wiping', async () => {
    const h = harness();
    let polls = 0;
    const seen: number[] = [];
    const report = await runResetFlow({
      realm: h.realm,
      stores: proxyStores(
        {
          ...h.stores,
          async workersPausedFor(epoch) {
            seen.push(epoch);
            polls += 1;
            return polls < 3 ? ['fanout'] : ['fanout', 'media-process', 'search-index'];
          },
        },
        [],
      ),
      log: () => undefined,
      pausePollIntervalMs: 1,
    });

    expect(polls).toBe(3);
    expect(seen).toEqual([41, 41, 41]); // the barrier polls with the epoch it set
    expect(report.steps.find((s) => s.name === 'wait-workers-paused')?.ok).toBe(true);
    expect(h.stores.events).toContain('reseed'); // wipes ran after the barrier
  });

  it('aborts before any store is wiped when workers never acknowledge the epoch', async () => {
    const h = harness();
    await expect(
      runResetFlow({
        realm: h.realm,
        stores: proxyStores(
          {
            ...h.stores,
            async workersPausedFor() {
              return [];
            },
          },
          [],
        ),
        log: () => undefined,
        pauseTimeoutMs: 10,
        pausePollIntervalMs: 5,
      }),
    ).rejects.toBeInstanceOf(ResetFlowError);

    // No wipe step ran - and the finally cleared the epoch (unpause).
    expect(h.stores.events).not.toContain('reseed');
    expect(h.stores.events).not.toContain('realm-reset');
    expect(h.stores.events).toContain('clear-epoch');
    expect(h.statusWrites[0]!.success).toBe(false);
    expect(h.statusWrites[0]!.steps.find((s) => s.name === 'wait-workers-paused')?.ok).toBe(false);
  });

  it('halts at a failed step, clears the epoch, and reports failure', async () => {
    const h = harness();
    const failing: StoreControls = {
      ...h.stores,
      async wipeBucket() {
        await h.stores.wipeBucket();
        throw new Error('rustfs exploded');
      },
    };

    await expect(
      runResetFlow({ realm: h.realm, stores: failing, log: () => undefined }),
    ).rejects.toBeInstanceOf(ResetFlowError);

    // Epoch was set before the failure and MUST be cleared after it (an
    // uncleared epoch is an event blackhole), and no step after the
    // failure ran (realm steps land in the realm's own log).
    expect(h.stores.events).toEqual([
      'flush',
      'set-epoch',
      'workers-paused',
      'reseed',
      'cms',
      'bucket',
      'status',
      'clear-epoch',
    ]);
    expect(h.realm.events).toEqual(['realm-reset', 'realm-init']);
    expect(h.statusWrites[0]!.success).toBe(false);
    expect(h.statusWrites[0]!.steps.find((s) => s.name === 'wipe-media-bucket')?.ok).toBe(false);
  });

  it('still clears the epoch when clearing it is what failed mid-flow', async () => {
    const h = harness();
    let clearCalls = 0;
    const failing: StoreControls = {
      ...h.stores,
      async clearResetEpoch() {
        clearCalls += 1;
        if (clearCalls === 1) throw new Error('valkey down');
        await h.stores.clearResetEpoch();
      },
    };

    await expect(
      runResetFlow({ realm: h.realm, stores: failing, log: () => undefined }),
    ).rejects.toBeInstanceOf(ResetFlowError);
    // The finally retried the clear (second call succeeded) even though the
    // step itself failed.
    expect(clearCalls).toBe(2);
  });

  it('writes the status record to the shared Valkey key after the run', async () => {
    const h = harness();
    await runResetFlow({
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
    expect(status.steps.map((s) => s.name)).toContain('wait-workers-paused');
  });

  it('emits the xitter_reset_* metric contract', async () => {
    const h = harness();
    const report = await runResetFlow({ realm: h.realm, stores: h.stores, log: () => undefined });
    const names = report.metrics.map((line) => line.split(/[ {]/)[0]);
    expect(names).toContain('xitter_reset_success');
    expect(names).toContain('xitter_reset_duration_seconds');
    expect(names).toContain('xitter_reset_reseeded');
    expect(names).toContain('xitter_reset_step_duration_seconds');
    expect(report.metrics.join('\n')).toContain('step="wait-workers-paused"');
  });
});
