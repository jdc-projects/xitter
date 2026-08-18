/**
 * Search-index worker: projects post and social events into the OpenSearch
 * posts index. Deployed as a Knative service; consumes Kafka only.
 */
import { kafkaBrokers, localPort, localUrl, loadRepoEnv, parseEnv } from '@xitter/config';
import { CONSUMER_GROUPS, runEventWorker } from '@xitter/events';
import { z } from 'zod';
import { handleEvent } from './handlers.js';

loadRepoEnv();

const env = parseEnv(
  z.object({
    KAFKA_BROKERS: z.string().min(1).default(kafkaBrokers()),
    SEARCH_INTERNAL_URL: z.string().url().default(localUrl('search')),
    METRICS_PORT: z.coerce.number().int().positive().default(localPort('searchIndexMetrics')),
  }),
);

await runEventWorker({
  service: 'search-index-worker',
  clientId: 'xitter-search-index-worker',
  brokers: env.KAFKA_BROKERS.split(','),
  groupId: CONSUMER_GROUPS.searchIndexWorker,
  topics: ['posts', 'social'],
  metricsPort: env.METRICS_PORT,
  handle: (envelope) => handleEvent(envelope, { searchInternalUrl: env.SEARCH_INTERNAL_URL }),
});
