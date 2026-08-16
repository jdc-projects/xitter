/**
 * Fanout worker: turns post.created / interaction events into materialised
 * feed entries. Deployed as a Knative service; consumes Kafka only.
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
    FEED_INTERNAL_URL: z.string().url().default(localUrl('feed')),
    METRICS_PORT: z.coerce.number().int().positive().default(localPort('fanoutMetrics')),
  }),
);

const logger = createLogger({ service: 'fanout-worker' });
const tracing = initTracing('fanout-worker');
initSentry('fanout-worker');

const consumer = createEventConsumer({
  clientId: 'xitter-fanout-worker',
  brokers: env.KAFKA_BROKERS.split(','),
  groupId: CONSUMER_GROUPS.fanoutWorker,
  topics: ['posts', 'social'],
});

const metrics = createMetricsServer(env.METRICS_PORT);
await metrics.started;
logger.info(`metrics on :${env.METRICS_PORT}`);

await consumer.run(async (envelope) => {
  await handleEvent(envelope, { feedInternalUrl: env.FEED_INTERNAL_URL });
});

process.once('SIGTERM', () => {
  void (async () => {
    await consumer.disconnect();
    await metrics.stop();
    await tracing.shutdown();
    process.exit(0);
  })();
});

logger.info('fanout-worker running');
