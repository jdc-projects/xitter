/**
 * Media-process worker: generates image variants (original, thumb) with sharp
 * and reports them back to the media service. Deployed as a Knative service;
 * consumes Kafka only.
 */
import { kafkaBrokers, localPort, localUrl, loadRepoEnv, parseEnv } from '@xitter/config';
import { CONSUMER_GROUPS, createEventConsumer } from '@xitter/events';
import { createLogger, createMetricsServer, initSentry, initTracing } from '@xitter/observability';
import { z } from 'zod';
import { handleEvent } from './handlers.js';

loadRepoEnv();

const env = parseEnv(
  z.object({
    KAFKA_BROKERS: z.string().min(1).default(kafkaBrokers()),
    MEDIA_INTERNAL_URL: z.string().url().default(localUrl('media')),
    METRICS_PORT: z.coerce.number().int().positive().default(localPort('mediaProcessMetrics')),
  }),
);

const logger = createLogger({ service: 'media-process-worker' });
const tracing = initTracing('media-process-worker');
initSentry('media-process-worker');

const consumer = createEventConsumer({
  clientId: 'xitter-media-process-worker',
  brokers: env.KAFKA_BROKERS.split(','),
  groupId: CONSUMER_GROUPS.mediaProcessWorker,
  topics: ['media'],
});

const metrics = createMetricsServer(env.METRICS_PORT);
await metrics.started;
logger.info(`metrics on :${env.METRICS_PORT}`);

await consumer.run(async (envelope) => {
  await handleEvent(envelope, { mediaInternalUrl: env.MEDIA_INTERNAL_URL });
});

process.once('SIGTERM', () => {
  void (async () => {
    await consumer.disconnect();
    await metrics.stop();
    await tracing.shutdown();
    process.exit(0);
  })();
});

logger.info(`media-process-worker running`);
