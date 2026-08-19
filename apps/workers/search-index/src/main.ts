/**
 * Search-index worker: projects post and social events into the OpenSearch
 * posts index via the search service's internal API. Deployed as a Knative
 * service; consumes Kafka only.
 *
 * Resume contract: the consumer group offsets die with the nightly reset's
 * group deletion, so the durable resume cursor is SearchCheckpoint in the
 * search DB (fetched at boot via the search internal API). A fresh group
 * replays the whole log from the beginning (idempotent upserts converge);
 * a checkpointed group resumes exactly after the last processed event.
 */
import { realmUrls } from '@xitter/auth';
import { SearchClient, SocialClient } from '@xitter/api-client';
import { kafkaBrokers, localPort, localUrl, loadRepoEnv, parseEnv } from '@xitter/config';
import { CONSUMER_GROUPS, runEventWorker } from '@xitter/events';
import { createLogger } from '@xitter/observability';
import { z } from 'zod';
import { handleEvent } from './handlers.js';

const logger = createLogger({ service: 'search-index-worker' });

loadRepoEnv();

const env = parseEnv(
  z.object({
    KAFKA_BROKERS: z.string().min(1).default(kafkaBrokers()),
    SEARCH_INTERNAL_URL: z.string().url().default(localUrl('search')),
    SOCIAL_INTERNAL_URL: z.string().url().default(localUrl('social')),
    METRICS_PORT: z.coerce.number().int().positive().default(localPort('searchIndexMetrics')),
    KEYCLOAK_BASE_URL: z.string().url().default(localUrl('keycloak')),
    DEMO_REALM: z.string().min(1).default('xitter-demo'),
    KEYCLOAK_CLIENT_ID: z.string().min(1).default('svc-worker-search-index'),
    KEYCLOAK_CLIENT_SECRET: z.string().min(1).default('svc-worker-search-index-local-secret'),
  }),
);

// Internal clients build /api/{service}/internal/... from the bare base URL
// (mirrors fanout); M2M tokens carry the scoped audiences (svc-search for
// indexing/checkpoints, svc-social for author-name lookups).
const internal = {
  tokenUrl: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).token,
  clientId: env.KEYCLOAK_CLIENT_ID,
  clientSecret: env.KEYCLOAK_CLIENT_SECRET,
};

// Constructed once: each client instance owns its JWT cache, so per-event
// construction would fetch a fresh Keycloak token per message.
const search = new SearchClient({ baseUrl: env.SEARCH_INTERNAL_URL, internal });
const social = new SocialClient({ baseUrl: env.SOCIAL_INTERNAL_URL, internal });

// Resume positions (`topic:partition` -> next offset to consume). Failure
// here is non-fatal: worst case the worker replays (idempotent) or starts
// from the log end (only when checkpoints and group offsets are both gone).
const resumeFrom = await search
  .internalGetCheckpoints(CONSUMER_GROUPS.searchIndexWorker)
  .then((result) => {
    const map = new Map<string, number>();
    for (const position of result.positions) {
      map.set(position.topicPartition, position.offset + 1);
    }
    if (map.size > 0) logger.info(`resuming from ${map.size} checkpoint(s)`);
    return map;
  })
  .catch((err: unknown) => {
    logger.warn({ err }, 'checkpoint fetch failed - starting without resume positions');
    return new Map<string, number>();
  });

await runEventWorker({
  service: 'search-index-worker',
  clientId: 'xitter-search-index-worker',
  brokers: env.KAFKA_BROKERS.split(','),
  groupId: CONSUMER_GROUPS.searchIndexWorker,
  topics: ['posts', 'social'],
  metricsPort: env.METRICS_PORT,
  // Fresh group = full replay (index rebuild); the checkpoint seeks take
  // over when positions exist.
  fromBeginning: true,
  resumeFrom,
  handle: (envelope, raw) =>
    handleEvent(envelope, raw, {
      search,
      social,
      consumerKey: CONSUMER_GROUPS.searchIndexWorker,
    }),
});
