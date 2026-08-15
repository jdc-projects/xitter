/**
 * Search-index worker: projects post and social events into the OpenSearch
 * posts index. Deployed as a Knative service; consumes Kafka only.
 */
import { kafkaBrokers, loadRepoEnv, parseEnv } from '@xitter/config';
import { CONSUMER_GROUPS, createEventConsumer } from '@xitter/events';
import { createLogger, createMetricsServer, initSentry, initTracing } from '@xitter/observability';
import { z } from 'zod';
import { handleEvent } from './handlers.js';

loadRepoEnv();

const env = parseEnv(
  z.object({
    KAFKA_BROKERS: z.string().min(1).default(kafkaBrokers()),
    SEARCH_INTERNAL_URL: z.string().url().default('http://localhost:8105'),
    METRICS_PORT: z.coerce
      .number()
      .int()
      .positive()
      .default(Number(process.env.XITTER_SEARCH_INDEX_METRICS_PORT ?? '9103')),
  }),
);

const logger = createLogger({ service: 'search-index-worker' });
const tracing = initTracing('search-index-worker');
initSentry('search-index-worker');

const consumer = createEventConsumer({
  clientId: 'xitter-search-index-worker',
  brokers: env.KAFKA_BROKERS.split(','),
  groupId: CONSUMER_GROUPS.searchIndexWorker,
  topics: ['posts', 'social'],
});

const metrics = createMetricsServer(env.METRICS_PORT);
await metrics.started;
logger.info(`metrics on :${env.METRICS_PORT}`);

await consumer.run(async (envelope) => {
  await handleEvent(envelope, { searchInternalUrl: env.SEARCH_INTERNAL_URL });
});

process.once('SIGTERM', () => {
  void (async () => {
    await consumer.disconnect();
    await metrics.stop();
    await tracing.shutdown();
    process.exit(0);
  })();
});

logger.info(`search-index-worker running`);
