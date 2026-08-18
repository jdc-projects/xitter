import { createLogger, createMetricsServer, initSentry, initTracing } from '@xitter/observability';
import { createEventConsumer, type EventConsumerOptions } from './consumer.js';

export interface EventWorkerOptions extends EventConsumerOptions {
  /** Worker identity for logs, tracing and Sentry (e.g. 'fanout-worker'). */
  service: string;
  /** Local Prometheus scrape port. */
  metricsPort: number;
  /** Event handler; must be idempotent (at-least-once delivery). */
  handle(envelope: unknown): Promise<void>;
}

/**
 * Shared worker bootstrap: consumer wiring, metrics server and graceful
 * SIGTERM shutdown in one call so per-worker mains stay declarative. Never
 * resolves while healthy (Kafka's eachMessage loop owns the event loop).
 */
export async function runEventWorker(options: EventWorkerOptions): Promise<void> {
  const logger = createLogger({ service: options.service });
  const tracing = initTracing(options.service);
  initSentry(options.service);

  const consumer = createEventConsumer(options);
  const metrics = createMetricsServer(options.metricsPort);
  await metrics.started;
  logger.info(`metrics on :${options.metricsPort}`);

  await consumer.run(async (envelope) => {
    await options.handle(envelope);
  });

  process.once('SIGTERM', () => {
    void (async () => {
      await consumer.disconnect();
      await metrics.stop();
      await tracing.shutdown();
      process.exit(0);
    })();
  });

  logger.info(`${options.service} running`);
}
