/**
 * Reset epoch gate - the worker side of the nightly reset's pause protocol
 * (ADR 0010). Instead of the reset quiescing workers through the Kubernetes
 * API (minScale patches, scale-to-zero waits), workers watch a shared epoch
 * flag in Valkey and pause THEMSELVES:
 *
 *   - reset: flush Valkey -> write `xitter:reset:epoch` = N -> wait for
 *     every worker's `xitter:reset:paused:<worker>` heartbeat to read N
 *     -> wipe stores -> delete the epoch (and heartbeats).
 *   - worker: epoch appears/changes -> pause all assigned partitions ->
 *     write the heartbeat once in-flight processing drained -> idle ->
 *     epoch removed -> seek every assigned partition to the LOG END
 *     (skip the pre-reset backlog - the "blackhole") -> resume.
 *
 * Fail-safes: a boot with NO epoch key is a fresh start - the first
 * assignment seeks to the log end so an unknown log is never replayed (a
 * worker that was down for an entire reset must not pour pre-reset events
 * back into freshly wiped stores). Valkey errors never crash the worker:
 * in `running` they just defer the transition (the reset's
 * wait-workers-paused step times out safely before any store is wiped),
 * while paused they keep the worker paused until Valkey returns.
 */
import { RESET_EPOCH_KEY, resetPausedKey } from '@xitter/config';
import { applyKafkaRequestQueueFix } from './kafka-request-queue-fix.js';

void applyKafkaRequestQueueFix();

/** Structural slice of Valkey the gate needs (unit-testable). */
export interface ResetEpochStore {
  get(key: string): Promise<string | null>;
  /** SET with an expiry, refreshing the heartbeat's freshness window. */
  setEx(key: string, value: string, ttlMs: number): Promise<void>;
  quit(): Promise<void>;
}

/** Structural slice of the kafkajs consumer the gate drives. */
export interface PausableConsumer {
  pause(topicPartitions: Array<{ topic: string; partitions?: number[] }>): void;
  resume(topicPartitions: Array<{ topic: string; partitions?: number[] }>): void;
  seek(topicPartitionOffset: { topic: string; partition: number; offset: string }): void;
}

export interface TopicPartitionsLike {
  topic: string;
  partitions: readonly number[];
}

/**
 * Resolves the REAL log-end offsets and seeks the consumer there.
 *
 * kafkajs has no seekToEnd, and the tempting shortcut - seek to the special
 * offset '-1' (LATEST) - POISONS the group under kafkajs 2.2.4's autoCommit:
 * offsetManager.seek COMMITS the raw '-1' to the broker, every later fetch
 * resolves against the invalid committed offset, and the consumer silently
 * stops consuming forever (reproduced against the live broker). Concrete
 * end offsets commit cleanly and survive worker restarts.
 */
export interface EndOffsetSeeker {
  seekToEnd(consumer: PausableConsumer, assignment: TopicPartitionsLike[]): Promise<void>;
  close(): Promise<void>;
}

export type ResetEpochState = 'running' | 'pausing' | 'paused';

export interface ResetEpochGateOptions {
  /** Canonical worker name (RESET_WORKERS) - names the heartbeat key. */
  worker: string;
  store: ResetEpochStore;
  consumer: PausableConsumer;
  /** Seeks the current assignment to the real log end (see EndOffsetSeeker). */
  seeker: EndOffsetSeeker;
  /**
   * Durable resume positions (`topic:partition` -> next offset, e.g.
   * search-index's checkpoints). The fresh-boot seek NEVER applies to
   * partitions covered here: the checkpoint is strictly better than the
   * log end, and the gate's async seek would otherwise clobber the
   * consumer's synchronous checkpoint seeks (kafkajs SeekOffsets is
   * last-write-wins). Checkpoints are wiped by the reset, so the
   * fail-safe still governs exactly when it matters.
   */
  resumeFrom?: ReadonlyMap<string, number>;
  /** Consecutive fully-idle polls required before the heartbeat is written. */
  pollIntervalMs?: number;
  heartbeatTtlMs?: number;
  logger?: {
    info(message: string): unknown;
    warn(entry: object, message: string): unknown;
  };
  now?: () => number;
}

export interface ResetEpochGate {
  /** Boot-time epoch read; true = a reset is in progress, start paused. */
  initialize(): Promise<boolean>;
  /**
   * GROUP_JOIN hook: tracks the current assignment, pauses it when a
   * reset is in progress (boot or rebalance), and applies the fresh-boot
   * seek-to-end fail-safe exactly once per process.
   */
  onAssignment(assignment: Record<string, readonly number[]>): void;
  /** Wraps a message handler for in-flight accounting. */
  track<T>(handle: () => Promise<T>): Promise<T>;
  /** One poll-cycle state transition (the timer drives this in prod). */
  check(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
  state(): ResetEpochState;
  /** State-transition observer (metrics wiring in runEventWorker). */
  onTransition(listener: (next: ResetEpochState, previous: ResetEpochState) => void): void;
}

interface TopicPartitions {
  topic: string;
  partitions: number[];
}

export function createResetEpochGate(options: ResetEpochGateOptions): ResetEpochGate {
  const log = options.logger ?? { info: () => undefined, warn: () => undefined };
  const now = options.now ?? Date.now;
  const heartbeatTtlMs = options.heartbeatTtlMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;

  let state: ResetEpochState = 'running';
  let knownEpoch: string | null = null;
  let assignment: TopicPartitions[] = [];
  let inFlight = 0;
  let idlePolls = 0;
  let heartbeatAt = 0;
  let bootedFresh = false;
  let soughtFreshBoot = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const transitions: Array<(next: ResetEpochState, previous: ResetEpochState) => void> = [];

  const assignedTopicPartitions = (): Array<{ topic: string; partitions?: number[] }> =>
    assignment.map(({ topic, partitions }) => ({ topic, partitions }));

  const pauseAssigned = (): void => {
    if (assignment.length > 0) options.consumer.pause(assignedTopicPartitions());
  };

  const resumeAssigned = (): void => {
    if (assignment.length > 0) options.consumer.resume(assignedTopicPartitions());
  };

  const seekAssignedToEnd = (): Promise<void> =>
    options.seeker.seekToEnd(options.consumer, assignment);

  /** Partitions owned by a durable resume cursor - exempt from the boot seek. */
  const resumeCovered = (topic: string, partition: number): boolean =>
    options.resumeFrom?.has(`${topic}:${partition}`) ?? false;

  /**
   * Fresh-boot seek, checkpoint-aware: only partitions with NO durable
   * resume position jump to the log end (never replay an unknown log).
   * Checkpointed partitions keep the consumer's own resume seeks - the
   * gate's async end-seek must not overwrite them (last-write-wins in
   * kafkajs, and the seek COMMITS - a clobbered checkpoint orphans the
   * gap between it and the log end).
   */
  const seekUncoveredToLogEnd = (): Promise<void> => {
    const uncovered = assignment
      .map(({ topic, partitions }) => ({
        topic,
        partitions: partitions.filter((p) => !resumeCovered(topic, p)),
      }))
      .filter(({ partitions }) => partitions.length > 0);
    if (uncovered.length === 0) return Promise.resolve();
    return options.seeker.seekToEnd(options.consumer, uncovered);
  };

  const transition = (next: ResetEpochState): void => {
    const previous = state;
    state = next;
    for (const listener of transitions) listener(next, previous);
  };

  const gate: ResetEpochGate = {
    state: () => state,

    onTransition(listener) {
      transitions.push(listener);
    },

    async initialize() {
      const epoch = await options.store.get(RESET_EPOCH_KEY);
      if (epoch === null) {
        // No reset in progress: normal start. The log's epoch relationship
        // is unknown, so the first assignment seeks to the log end rather
        // than replaying it (fail-safe, below).
        bootedFresh = true;
        return false;
      }
      knownEpoch = epoch;
      transition('pausing');
      return true;
    },

    onAssignment(memberAssignment) {
      assignment = Object.entries(memberAssignment).map(([topic, partitions]) => ({
        topic,
        partitions: [...partitions],
      }));
      if (bootedFresh && !soughtFreshBoot) {
        // Fresh boot against an unknown log: never replay it. This covers
        // both a brand-new consumer group and a group whose committed
        // offsets predate a reset the worker did not observe. Checkpointed
        // partitions are EXEMPT (see seekUncoveredToLogEnd). Fire-and-
        // forget: the default start position is already the log end, this
        // seek only pins it for groups with stale committed offsets.
        soughtFreshBoot = true;
        seekUncoveredToLogEnd().catch((err) =>
          log.warn({ err }, 'fresh-boot seek to log end failed'),
        );
      }
      if (state !== 'running') {
        // Boot into an in-progress reset, or a rebalance while paused:
        // everything we now hold must be held paused.
        pauseAssigned();
      } else {
        // kafkajs pause marks persist per topic-partition across
        // rebalances; a partition paused during an epoch, moved away, and
        // re-assigned after the clear would otherwise stay silently
        // paused. resume() is a no-op for unpaused partitions.
        resumeAssigned();
      }
    },

    async track<T>(handle: () => Promise<T>): Promise<T> {
      inFlight += 1;
      idlePolls = 0;
      try {
        return await handle();
      } finally {
        inFlight -= 1;
      }
    },

    async check() {
      try {
        // One poll = one state-specific transition (Valkey errors defer to
        // the next tick; see the catch below).
        if (state === 'running') await checkRunning();
        else if (state === 'pausing') await checkPausing();
        else await checkPaused();
      } catch (err) {
        // Valkey unavailable: never crash the worker over the gate. In
        // `running` the transition simply defers (the reset fails safely
        // at its own wait step); while paused we stay paused and retry.
        log.warn({ err }, 'reset epoch check failed - will retry');
      }
    },

    start() {
      if (timer) return;
      timer = setInterval(() => void gate.check(), pollIntervalMs);
    },

    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.all([
        options.store.quit().then(
          () => undefined,
          () => undefined,
        ),
        options.seeker.close().then(
          () => undefined,
          () => undefined,
        ),
      ]);
    },
  };

  /** Running: pause as soon as a NEW epoch appears. */
  async function checkRunning(): Promise<void> {
    const epoch = await options.store.get(RESET_EPOCH_KEY);
    if (epoch === null || epoch === knownEpoch) return;
    pauseAssigned(); // stop fetches immediately; drain what is in flight
    // Record the epoch only after a successful pause: a throwing pause
    // (pre-run edge case) must retry the whole transition next tick, not
    // silently ignore the epoch it failed to react to.
    knownEpoch = epoch;
    idlePolls = 0;
    transition('pausing');
    log.info(`reset epoch ${epoch} observed - pausing consumption`);
  }

  /**
   * Pausing: the epoch is held but in-flight work may still be draining.
   * Only promise the reset we are quiet once the queue is fully idle.
   */
  async function checkPausing(): Promise<void> {
    const epoch = await options.store.get(RESET_EPOCH_KEY);
    if (epoch === null) {
      // The reset that started this pause vanished (its Valkey flush ran
      // again, or it failed before we acknowledged). No wipe is in
      // progress: resume where we left off - nothing was skipped.
      resumeAssigned();
      knownEpoch = null;
      idlePolls = 0;
      transition('running');
      log.info('reset epoch cleared before pause completed - resuming');
      return;
    }
    if (epoch !== knownEpoch) {
      // A newer epoch superseded ours mid-drain; acknowledge that one.
      knownEpoch = epoch;
    }
    if (inFlight > 0) {
      idlePolls = 0;
      return;
    }
    // Require the queue to be idle across two consecutive polls before
    // promising the reset we are quiet: batches fetched in the same cycle
    // as the pause() can still be draining.
    idlePolls += 1;
    if (idlePolls < 2) return;
    await writeHeartbeat();
    idlePolls = 0;
    transition('paused');
    log.info(`paused for reset epoch ${knownEpoch} (heartbeat written)`);
  }

  /** Paused: idle until the epoch key is removed, then skip + resume. */
  async function checkPaused(): Promise<void> {
    const epoch = await options.store.get(RESET_EPOCH_KEY);
    if (epoch === null) {
      // Reset complete: skip the pre-reset backlog entirely and resume.
      // A failed seek must NOT resume into a replay - stay paused and
      // retry the whole transition on the next poll.
      await seekAssignedToEnd();
      resumeAssigned();
      knownEpoch = null;
      idlePolls = 0;
      transition('running');
      log.info('reset epoch cleared - seeking to log end and resuming');
      return;
    }
    if (epoch !== knownEpoch) {
      // Epoch bumped while already paused (reset retried): re-ack.
      knownEpoch = epoch;
      await writeHeartbeat();
      return;
    }
    if (now() - heartbeatAt > heartbeatTtlMs / 3) await writeHeartbeat();
  }

  async function writeHeartbeat(): Promise<void> {
    await options.store.setEx(resetPausedKey(options.worker), knownEpoch!, heartbeatTtlMs);
    heartbeatAt = now();
  }

  return gate;
}

/**
 * Valkey-backed epoch store: one lazily-connected ioredis client per
 * worker process, sharing the repo's handshake policy (fail-fast boot,
 * no leaked retrying clients).
 */
export async function connectValkeyEpochStore(url: string): Promise<ResetEpochStore> {
  const { connectValkey } = await import('@xitter/observability');
  interface ValkeyLike {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
    quit(): Promise<unknown>;
  }
  const redis = await connectValkey<ValkeyLike>({ url });
  return {
    get: (key) => redis.get(key),
    async setEx(key, value, ttlMs) {
      await redis.set(key, value, 'EX', Math.max(1, Math.ceil(ttlMs / 1000)));
    },
    async quit() {
      await redis.quit().then(
        () => undefined,
        () => undefined,
      );
    },
  };
}

/**
 * Kafka-admin-backed EndOffsetSeeker: resolves each assigned topic's real
 * end offsets (fetchTopicOffsets) and seeks every assigned partition to
 * its concrete value. One lazily-connected admin client per worker,
 * reused across resets and closed with the gate.
 */
export function createAdminEndOffsetSeeker(options: {
  clientId: string;
  brokers: string[];
}): EndOffsetSeeker {
  let admin: AdminLike | null = null;

  const connected = async (): Promise<AdminLike> => {
    if (!admin) {
      const { Kafka } = await import('kafkajs');
      const client = new Kafka(options).admin();
      await client.connect();
      // Only cache after a successful connect: a cached client whose
      // initial connect failed would never retry, wedging the worker in
      // `paused` on a dead handle.
      admin = client;
    }
    return admin;
  };

  return {
    async seekToEnd(consumer, assignment) {
      if (assignment.length === 0) return;
      const client = await connected();
      const byTopic = new Map(assignment.map(({ topic, partitions }) => [topic, partitions]));
      for (const topic of byTopic.keys()) {
        const ends = await client.fetchTopicOffsets(topic);
        for (const { partition, offset } of ends) {
          if (!byTopic.get(topic)!.includes(partition)) continue;
          consumer.seek({ topic, partition, offset });
        }
      }
    },
    async close() {
      await admin?.disconnect().then(
        () => undefined,
        () => undefined,
      );
      admin = null;
    },
  };
}

interface AdminLike {
  connect(): Promise<void>;
  fetchTopicOffsets(topic: string): Promise<Array<{ partition: number; offset: string }>>;
  disconnect(): Promise<void>;
}
