/**
 * Fanout worker: turns post.created / interaction events into materialised
 * feed entries. Deployed as a Knative service; consumes Kafka only.
 */
import { kafkaBrokers, localPort, localUrl, loadRepoEnv, parseEnv } from '@xitter/config';
import { CONSUMER_GROUPS, runEventWorker } from '@xitter/events';
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

await runEventWorker({
  service: 'fanout-worker',
  clientId: 'xitter-fanout-worker',
  brokers: env.KAFKA_BROKERS.split(','),
  groupId: CONSUMER_GROUPS.fanoutWorker,
  topics: ['posts', 'social'],
  metricsPort: env.METRICS_PORT,
  handle: (envelope) => handleEvent(envelope, { feedInternalUrl: env.FEED_INTERNAL_URL }),
});
