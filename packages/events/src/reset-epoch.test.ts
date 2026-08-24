import { describe, expect, it } from 'vitest';
import { RESET_EPOCH_KEY, resetPausedKey } from '@xitter/config';
import {
  createResetEpochGate,
  type EndOffsetSeeker,
  type PausableConsumer,
  type ResetEpochStore,
} from './reset-epoch.js';

/**
 * Epoch-transition contracts of the reset pause gate (ADR 0010): the
 * worker pauses itself when the shared epoch appears/changes, acknowledges
 * with a heartbeat only after in-flight work drained, skips the pre-reset
 * log on resume (seek to end), never replays an unknown log at boot, and
 * survives Valkey errors without crashing. Store and consumer are faked;
 * the timer-driven loop is driven by calling check() directly.
 */

class FakeStore implements ResetEpochStore {
  values = new Map<string, string>();
  ttls: Record<string, number> = {};
  failNext = false;
  sets = 0;

  async get(key: string): Promise<string | null> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('valkey unreachable');
    }
    return this.values.get(key) ?? null;
  }

  async setEx(key: string, value: string, ttlMs: number): Promise<void> {
    this.sets += 1;
    this.values.set(key, value);
    this.ttls[key] = ttlMs;
  }

  async quit(): Promise<void> {}
}

interface RecordedCall {
  kind: 'pause' | 'resume' | 'seek';
  topic: string;
  partition: number;
}

class FakeConsumer implements PausableConsumer {
  calls: RecordedCall[] = [];

  pause(topicPartitions: Array<{ topic: string; partitions?: number[] }>): void {
    for (const { topic, partitions } of topicPartitions) {
      for (const partition of partitions ?? [])
        this.calls.push({ kind: 'pause', topic, partition });
    }
  }

  resume(topicPartitions: Array<{ topic: string; partitions?: number[] }>): void {
    for (const { topic, partitions } of topicPartitions) {
      for (const partition of partitions ?? [])
        this.calls.push({ kind: 'resume', topic, partition });
    }
  }

  seek(topicPartitionOffset: { topic: string; partition: number; offset: string }): void {
    this.calls.push({
      kind: 'seek',
      topic: topicPartitionOffset.topic,
      partition: topicPartitionOffset.partition,
    });
  }

  of(kind: RecordedCall['kind']): string[] {
    return this.calls.filter((c) => c.kind === kind).map((c) => `${c.topic}:${c.partition}`);
  }
}

const ASSIGNMENT = { 'xitter.posts.v1': [0, 1], 'xitter.social.v1': [2] };

/** Deterministic admin-backed seeker stand-in: end offset = partition + 100. */
class FakeSeeker implements EndOffsetSeeker {
  async seekToEnd(
    consumer: PausableConsumer,
    assignment: Array<{ topic: string; partitions: readonly number[] }>,
  ): Promise<void> {
    for (const { topic, partitions } of assignment) {
      for (const partition of partitions) {
        consumer.seek({ topic, partition, offset: String(partition + 100) });
      }
    }
  }

  async close(): Promise<void> {}
}

interface Harness {
  store: FakeStore;
  consumer: FakeConsumer;
  gate: ReturnType<typeof createResetEpochGate>;
}

function harness(worker = 'fanout'): Harness {
  const store = new FakeStore();
  const consumer = new FakeConsumer();
  const gate = createResetEpochGate({
    worker,
    store,
    consumer,
    seeker: new FakeSeeker(),
    logger: { info: () => undefined, warn: () => undefined },
  });
  return { store, consumer, gate };
}

describe('createResetEpochGate', () => {
  it('boots running when no epoch is set and seeks the first assignment to the log end', async () => {
    const h = harness();
    expect(await h.gate.initialize()).toBe(false);
    expect(h.gate.state()).toBe('running');

    h.gate.onAssignment(ASSIGNMENT);
    // Fail-safe: an unknown log is never replayed - fresh boot seeks to end.
    expect(h.consumer.of('seek')).toEqual([
      'xitter.posts.v1:0',
      'xitter.posts.v1:1',
      'xitter.social.v1:2',
    ]);
    await h.gate.check();
    expect(h.gate.state()).toBe('running');
    expect(h.consumer.of('pause')).toEqual([]);
  });

  it('boots paused when an epoch is already set (reset in progress)', async () => {
    const h = harness();
    h.store.values.set(RESET_EPOCH_KEY, '7');
    expect(await h.gate.initialize()).toBe(true);
    expect(h.gate.state()).toBe('pausing');

    h.gate.onAssignment(ASSIGNMENT);
    expect(h.consumer.of('pause')).toEqual([
      'xitter.posts.v1:0',
      'xitter.posts.v1:1',
      'xitter.social.v1:2',
    ]);
    // No fresh-boot seek-to-end here: the resume after the epoch clears does it.
    expect(h.consumer.of('seek')).toEqual([]);
  });

  it('pauses, heartbeats after the drain, then seeks to end and resumes on clear', async () => {
    const h = harness();
    // Boot INTO the in-progress reset so the only seeks are the resume
    // ones (the fresh-boot fail-safe is covered by its own test).
    h.store.values.set(RESET_EPOCH_KEY, '3');
    await h.gate.initialize();
    h.gate.onAssignment(ASSIGNMENT);

    await h.gate.check();
    expect(h.gate.state()).toBe('pausing');
    expect(h.consumer.of('pause')).toHaveLength(3);
    expect(h.store.values.get(resetPausedKey('fanout'))).toBeUndefined();

    // Drain takes two consecutive fully-idle polls (belt-and-braces against
    // batches fetched in the same cycle as the pause).
    await h.gate.check();
    expect(h.gate.state()).toBe('paused');
    expect(h.store.values.get(resetPausedKey('fanout'))).toBe('3');

    h.store.values.delete(RESET_EPOCH_KEY);
    await h.gate.check();
    expect(h.gate.state()).toBe('running');
    // Pre-reset backlog skipped: every assigned partition sought to the end.
    expect(h.consumer.of('seek')).toEqual([
      'xitter.posts.v1:0',
      'xitter.posts.v1:1',
      'xitter.social.v1:2',
    ]);
    expect(h.consumer.of('resume')).toHaveLength(3);
    // Ready for the next epoch cycle.
    h.store.values.set(RESET_EPOCH_KEY, '4');
    await h.gate.check();
    expect(h.gate.state()).toBe('pausing');
  });

  it('defers the heartbeat while a handler is in flight', async () => {
    const h = harness();
    await h.gate.initialize();
    h.gate.onAssignment(ASSIGNMENT);
    h.store.values.set(RESET_EPOCH_KEY, '5');

    let release!: () => void;
    const blocked = h.gate.track(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await h.gate.check();
    await h.gate.check();
    await h.gate.check();
    expect(h.gate.state()).toBe('pausing');
    expect(h.store.values.get(resetPausedKey('fanout'))).toBeUndefined();

    release();
    await blocked;
    await h.gate.check();
    await h.gate.check();
    expect(h.gate.state()).toBe('paused');
    expect(h.store.values.get(resetPausedKey('fanout'))).toBe('5');
  });

  it('abandons a pause whose epoch vanished before acknowledgement (no seek, resume in place)', async () => {
    const h = harness();
    // Boot into an in-progress reset, then have it vanish before the
    // heartbeat is ever written (the reset's flush ran again).
    h.store.values.set(RESET_EPOCH_KEY, '9');
    await h.gate.initialize();
    h.gate.onAssignment(ASSIGNMENT);
    expect(h.gate.state()).toBe('pausing');

    h.store.values.delete(RESET_EPOCH_KEY);
    await h.gate.check();
    expect(h.gate.state()).toBe('running');
    expect(h.consumer.of('seek')).toEqual([]); // nothing was skipped
    expect(h.consumer.of('resume')).toHaveLength(3);
  });

  it('re-acknowledges when the epoch is bumped while already paused', async () => {
    const h = harness();
    h.store.values.set(RESET_EPOCH_KEY, '1');
    await h.gate.initialize();
    h.gate.onAssignment(ASSIGNMENT);
    await h.gate.check();
    await h.gate.check();
    expect(h.store.values.get(resetPausedKey('fanout'))).toBe('1');

    h.store.values.set(RESET_EPOCH_KEY, '2');
    await h.gate.check();
    expect(h.store.values.get(resetPausedKey('fanout'))).toBe('2');
    expect(h.gate.state()).toBe('paused');
  });

  it('keeps the heartbeat TTL refreshed while paused', async () => {
    const store = new FakeStore();
    const consumer = new FakeConsumer();
    let clock = 0;
    const gate = createResetEpochGate({
      worker: 'media-process',
      store,
      consumer,
      seeker: new FakeSeeker(),
      logger: { info: () => undefined, warn: () => undefined },
      now: () => clock,
    });
    store.values.set(RESET_EPOCH_KEY, '6');
    await gate.initialize();
    gate.onAssignment(ASSIGNMENT);
    await gate.check();
    await gate.check();
    expect(store.sets).toBe(1);

    clock = 30_000; // > ttl/3 with the 60s default
    await gate.check();
    expect(store.sets).toBe(2);
  });

  it('survives Valkey errors without crashing (defers the transition)', async () => {
    const h = harness();
    await h.gate.initialize();
    h.gate.onAssignment(ASSIGNMENT);
    h.store.values.set(RESET_EPOCH_KEY, '8');
    h.store.failNext = true;
    await h.gate.check(); // get throws -> swallowed
    expect(h.gate.state()).toBe('running');
    await h.gate.check(); // now reads the epoch
    expect(h.gate.state()).toBe('pausing');
  });

  it('pauses partitions gained via rebalance while a reset is in progress', async () => {
    const h = harness();
    await h.gate.initialize();
    h.gate.onAssignment({ 'xitter.posts.v1': [0] });
    h.store.values.set(RESET_EPOCH_KEY, '3');
    await h.gate.check();
    await h.gate.check();
    await h.gate.check();
    expect(h.gate.state()).toBe('paused');

    // Rebalance hands over a new partition while paused: it must arrive paused.
    h.gate.onAssignment({ 'xitter.posts.v1': [0], 'xitter.social.v1': [4] });
    expect(h.consumer.of('pause')).toContain('xitter.social.v1:4');

    h.store.values.delete(RESET_EPOCH_KEY);
    await h.gate.check();
    expect(h.consumer.of('seek')).toContain('xitter.social.v1:4');
    expect(h.consumer.of('resume')).toContain('xitter.social.v1:4');
  });
});
