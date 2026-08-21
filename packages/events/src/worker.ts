import client from 'prom-client';
import { Kafka, type EachMessagePayload } from 'kafkajs';
import { createLogger, createMetricsServer, initSentry, initTracing } from '@xitter/observability';
import {
  createEventConsumer,
  type EventConsumerOptions,
  type EventConsumerRunOptions,
} from './consumer.js';
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

  const consumer = createEventConsumer(options);
  const metrics = createMetricsServer(options.metricsPort);
  await metrics.started;
  logger.info(`metrics on :${options.metricsPort}`);

  const lag = startConsumerLagTracker(options, metrics.registry, logger);

  const runOptions: EventConsumerRunOptions = options.resumeFrom
    ? { resumeFrom: options.resumeFrom }
    : {};
  await consumer
    .run(async (envelope, raw) => {
      await options.handle(envelope, raw);
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
