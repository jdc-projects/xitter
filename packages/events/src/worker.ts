import client from 'prom-client';
import { Kafka, type Consumer, type EachMessagePayload } from 'kafkajs';
import { createLogger, createMetricsServer, initSentry, initTracing } from '@xitter/observability';
import type { ResetWorkerName } from '@xitter/config';
import {
  createEventConsumer,
  type EventConsumerOptions,
  type EventConsumerRunOptions,
} from './consumer.js';
import {
  createAdminEndOffsetSeeker,
  createResetEpochGate,
  connectValkeyEpochStore,
} from './reset-epoch.js';
import { TOPICS } from './topics.js';

export interface EventWorkerOptions extends EventConsumerOptions {
  /** Worker identity for logs, tracing and Sentry (e.g. 'fanout-worker'). */
  service: string;
  /** Local Prometheus scrape port. */
  metricsPort: number;
  /** Event handler; must be idempotent (at-least-once delivery). */
  handle(envelope: unknown, raw?: EachMessagePayload): Promise<void>;
  /**
   * Checkpoint resume positions (`topic:partition` -> next offset), applied
   * on partition assignment - see EventConsumerRunOptions.resumeFrom.
   */
  resumeFrom?: ReadonlyMap<string, number>;
  /**
   * Reset-epoch pause gate (ADR 0010): while the nightly reset holds an
   * epoch in Valkey the worker pauses itself, then resumes at the log end
   * when the reset clears it. Takes over start-position semantics - a
   * fresh group starts at the log end (never replays an unknown log), so
   * `fromBeginning` is ignored when this is set.
   */
  resetPause?: { worker: ResetWorkerName; valkeyUrl: string; brokers: string[] };
}

/**
 * Shared worker bootstrap: consumer wiring, metrics server, consumer-lag
 * gauge and graceful SIGTERM shutdown in one call so per-worker mains stay
 * declarative. Never resolves while healthy (Kafka's eachMessage loop owns
 * the event loop).
 */
export async function runEventWorker(options: EventWorkerOptions): Promise<void> {
  const logger = createLogger({ service: options.service });
  const tracing = initTracing(options.service);
  initSentry(options.service);

  const consumer = createEventConsumer(
    options.resetPause ? { ...options, fromBeginning: false } : options,
  );
  const metrics = createMetricsServer(options.metricsPort);
  await metrics.started;
  logger.info(`metrics on :${options.metricsPort}`);

  // Reset-epoch gate (ADR 0010): the worker pauses itself while the nightly
  // reset holds an epoch flag in Valkey. Boot fail-fast: without Valkey the
  // pause protocol cannot work, so a worker that cannot reach it must not
  // start consuming.
  const gate = options.resetPause
    ? await createWorkerResetGate(options, consumer.consumer, metrics.registry, logger)
    : null;
  // Rebalance events for the Kafka dashboard (spec 06, #12): GROUP_JOIN fires
  // on the initial assignment and on every subsequent group rebalance.
  const rebalances = new client.Counter({
    name: 'xitter_kafka_rebalances_total',
    help: 'Consumer group (re)joins: initial assignment plus every rebalance',
    labelNames: ['group'],
    registers: [metrics.registry],
  });
  consumer.consumer.on(consumer.consumer.events.GROUP_JOIN, (event) => {
    rebalances.inc({ group: options.groupId });
    gate?.onAssignment(event.payload.memberAssignment);
  });

  const lag = startConsumerLagTracker(options, metrics.registry, logger);

  const runOptions: EventConsumerRunOptions = options.resumeFrom
    ? { resumeFrom: options.resumeFrom }
    : {};
  // The gate timer starts before run() resolves (it never does while
  // healthy); first tick lands after the group has joined in practice, and
  // a too-early tick just retries on the next one.
  gate?.start();
  await consumer
    .run(async (envelope, raw) => {
      if (!gate) {
        await options.handle(envelope, raw);
        return;
      }
      await gate.track(() => options.handle(envelope, raw));
    }, runOptions)
    .catch((err: unknown) => {
      // Consumer crash (handler failure exhausted all retries): without this
      // the rejection surfaced only as a silent process exit, leaving the
      // worker's derived store stalled with nothing in the logs.
      logger.error({ err }, `${options.service}: consumer crashed - worker exiting`);
      throw err;
    });

  process.once('SIGTERM', () => {
    void (async () => {
      await lag.stop();
      await gate?.stop();
      await consumer.disconnect();
      await metrics.stop();
      await tracing.shutdown();
      process.exit(0);
    })();
  });

  logger.info(`${options.service} running`);
}

export interface ConsumerLagTracker {
  stop(): Promise<void>;
}

/**
 * Build the worker's reset-epoch gate (ADR 0010) and register its pause
 * metrics. Returns an INITIALISED gate (already past the boot epoch read).
 */
async function createWorkerResetGate(
  options: EventWorkerOptions,
  consumer: Consumer,
  registry: client.Registry,
  logger: { info(message: string): unknown; warn(entry: object, message: string): unknown },
): Promise<ReturnType<typeof createResetEpochGate>> {
  const resetPause = options.resetPause!;
  const gate = createResetEpochGate({
    worker: resetPause.worker,
    store: await connectValkeyEpochStore(resetPause.valkeyUrl),
    consumer: {
      pause: (topicPartitions) => consumer.pause(topicPartitions),
      resume: (topicPartitions) => consumer.resume(topicPartitions),
      seek: (seek) => consumer.seek(seek),
    },
    // Never seek the special '-1' (LATEST) offset: kafkajs 2.2.4's
    // autoCommit persists the raw value to the broker and poisons the
    // group (silent stop, reproduced live). The admin seeker resolves
    // concrete end offsets instead.
    seeker: createAdminEndOffsetSeeker({
      clientId: `xitter-${resetPause.worker}-reset-seeker`,
      brokers: resetPause.brokers,
    }),
    logger: { info: (m) => logger.info(m), warn: (e, m) => logger.warn(e, m) },
  });
  const pausedGauge = new client.Gauge({
    name: 'xitter_reset_epoch_paused',
    help: '1 while this worker is paused for an in-progress reset epoch',
    registers: [registry],
  });
  const pauses = new client.Counter({
    name: 'xitter_reset_epoch_pauses_total',
    help: 'Reset epochs this worker paused for since boot',
    registers: [registry],
  });
  const startPaused = await gate.initialize();
  pausedGauge.set(startPaused ? 1 : 0);
  gate.onTransition((next, previous) => {
    pausedGauge.set(next === 'running' ? 0 : 1);
    if (previous === 'running' && next !== 'running') pauses.inc();
  });
  return gate;
}

/**
 * Consumer-lag gauge (`xitter_kafka_consumer_lag{topic,partition}`, #12
 * alerting): committed group offsets vs the log end, polled on an interval -
 * Kafka exposes no push-based lag metric. Best-effort: a failed poll logs and
 * keeps the previous values rather than killing the worker.
 */
export function startConsumerLagTracker(
  options: EventConsumerOptions,
  registry: client.Registry,
  logger: { warn(entry: object, message: string): unknown },
  intervalMs = 30_000,
): ConsumerLagTracker {
  const gauge = new client.Gauge({
    name: 'xitter_kafka_consumer_lag',
    help: 'Messages behind the log end for this consumer group, per topic partition',
    labelNames: ['topic', 'partition'],
    registers: [registry],
  });

  const kafka = new Kafka({ clientId: options.clientId, brokers: options.brokers });
  const admin = kafka.admin();
  const prefix = options.topicPrefix ? `${options.topicPrefix}.` : '';
  const topics = options.topics.map((topic) => `${prefix}${TOPICS[topic]}`);

  const poll = async (): Promise<void> => {
    for (const topic of topics) {
      try {
        const [end, committed] = await Promise.all([
          admin.fetchTopicOffsets(topic),
          admin.fetchOffsets({ groupId: options.groupId, topics: [topic] }),
        ]);
        const committedByPartition = new Map(
          (committed[0]?.partitions ?? []).map(({ partition, offset }) => [
            partition,
            Number(offset),
          ]),
        );
        for (const { partition, high } of end) {
          const position = committedByPartition.get(partition) ?? -1;
          // No commit yet (-1) reads as "nothing consumed": lag = full log.
          gauge.set(
            { topic, partition: String(partition) },
            Math.max(0, Number(high) - Math.max(0, position)),
          );
        }
      } catch (err) {
        logger.warn({ err, topic }, 'consumer lag poll failed');
      }
    }
  };

  const timer = setInterval(() => void poll(), intervalMs);
  timer.unref();
  // First reading without waiting a full interval.
  void admin
    .connect()
    .then(poll)
    .catch((err: unknown) => logger.warn({ err }, 'lag admin connect failed'));

  return {
    async stop() {
      clearInterval(timer);
      await admin.disconnect().catch(() => undefined);
    },
  };
}
