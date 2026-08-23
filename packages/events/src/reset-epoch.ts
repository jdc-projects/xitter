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
  seekToEnd(topic: string, partition: number): void;
}

export type ResetEpochState = 'running' | 'pausing' | 'paused';

export interface ResetEpochGateOptions {
  /** Canonical worker name (RESET_WORKERS) - names the heartbeat key. */
  worker: string;
  store: ResetEpochStore;
  consumer: PausableConsumer;
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

  const seekAssignedToEnd = (): void => {
    // kafkajs resolves the special offset -1 (LATEST) against broker
    // metadata at fetch time - the documented seek-to-end.
    for (const { topic, partitions } of assignment) {
      for (const partition of partitions) options.consumer.seekToEnd(topic, partition);
    }
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
        // offsets predate a reset the worker did not observe.
        soughtFreshBoot = true;
        seekAssignedToEnd();
      }
      if (state !== 'running') {
        // Boot into an in-progress reset, or a rebalance while paused:
        // everything we now hold must be held paused.
        pauseAssigned();
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
        if (state === 'running') {
          const epoch = await options.store.get(RESET_EPOCH_KEY);
          if (epoch !== null && epoch !== knownEpoch) {
            knownEpoch = epoch;
            pauseAssigned(); // stop fetches immediately; drain what is in flight
            idlePolls = 0;
            transition('pausing');
            log.info(`reset epoch ${epoch} observed - pausing consumption`);
          }
          return;
        }

        if (state === 'pausing') {
          const epoch = await options.store.get(RESET_EPOCH_KEY);
          if (epoch === null) {
            // The reset that started this pause vanished (its Valkey flush
            // ran again, or it failed before we acknowledged). No wipe is
            // in progress: resume where we left off - nothing was skipped.
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
          // Require the queue to be idle across two consecutive polls
          // before promising the reset we are quiet: batches fetched in
          // the same cycle as the pause() can still be draining.
          idlePolls += 1;
          if (idlePolls < 2) return;
          await options.store.setEx(resetPausedKey(options.worker), knownEpoch, heartbeatTtlMs);
          heartbeatAt = now();
          idlePolls = 0;
          transition('paused');
          log.info(`paused for reset epoch ${knownEpoch} (heartbeat written)`);
          return;
        }

        // paused
        const epoch = await options.store.get(RESET_EPOCH_KEY);
        if (epoch === null) {
          // Reset complete: skip the pre-reset backlog entirely and resume.
          seekAssignedToEnd();
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
          await options.store.setEx(resetPausedKey(options.worker), knownEpoch, heartbeatTtlMs);
          heartbeatAt = now();
          return;
        }
        if (now() - heartbeatAt > heartbeatTtlMs / 3) {
          await options.store.setEx(resetPausedKey(options.worker), knownEpoch, heartbeatTtlMs);
          heartbeatAt = now();
        }
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
      await options.store.quit().then(
        () => undefined,
        () => undefined,
      );
    },
  };

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
