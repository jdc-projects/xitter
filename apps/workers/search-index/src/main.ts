/**
 * Search-index worker: projects post and social events into the OpenSearch
 * posts index via the search service's internal API. Deployed as a Knative
 * service; consumes Kafka only.
 *
 * Resume contract: the nightly reset no longer deletes consumer groups
 * (ADR 0010) - the reset epoch gate pauses this worker and seeks it to the
 * log end around each wipe - but a restart outside a reset still relies on
 * the durable resume cursor (SearchCheckpoint in the search DB, fetched at
 * boot via the search internal API). A fresh group starts at the log end
 * (gate fail-safe); a checkpointed group resumes exactly after the last
 * processed event.
 */
import { internalCredentials, SearchClient, SocialClient } from '@xitter/api-client';
import {
  kafkaBrokers,
  localPort,
  localUrl,
  loadRepoEnv,
  parseEnv,
  valkeyUrl,
} from '@xitter/config';
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
    VALKEY_URL: z.string().url().default(valkeyUrl()),
  }),
);

// Internal clients build /api/{service}/internal/... from the bare base URL
// (mirrors fanout); M2M tokens carry the scoped audiences (svc-search for
// indexing/checkpoints, svc-social for author-name lookups).
const internal = internalCredentials(env);

// Constructed once: each client instance owns its JWT cache, so per-event
// construction would fetch a fresh Keycloak token per message.
const search = new SearchClient({ baseUrl: env.SEARCH_INTERNAL_URL, internal });
const social = new SocialClient({ baseUrl: env.SOCIAL_INTERNAL_URL, internal });

// Resume positions (`topic:partition` -> next offset to consume). Fetched
// with patience: turbo starts services and workers in parallel, so the
// search service may still be booting when we get here - an instant
// give-up lands the worker on a fresh-group full replay (fromBeginning),
// minutes of catch-up during which new posts sit unconsumed (observed as
// search e2e convergence failures). Retry until the service answers or the
// window closes; only then fall back to no resume positions.
const CHECKPOINT_FETCH_WINDOW_MS = 90_000;

async function fetchCheckpoints(): Promise<Map<string, number>> {
  const result = await search.internalGetCheckpoints(CONSUMER_GROUPS.searchIndexWorker);
  const map = new Map<string, number>();
  for (const position of result.positions) {
    map.set(position.topicPartition, position.offset + 1);
  }
  if (map.size > 0) logger.info(`resuming from ${map.size} checkpoint(s)`);
  return map;
}

async function fetchResumePositions(): Promise<Map<string, number>> {
  const deadline = Date.now() + CHECKPOINT_FETCH_WINDOW_MS;
  for (;;) {
    try {
      return await fetchCheckpoints();
    } catch (err) {
      if (Date.now() > deadline) {
        logger.warn({ err }, 'checkpoint fetch failed - starting without resume positions');
        return new Map<string, number>();
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}
const resumeFrom = await fetchResumePositions();

await runEventWorker({
  service: 'search-index-worker',
  clientId: 'xitter-search-index-worker',
  brokers: env.KAFKA_BROKERS.split(','),
  groupId: CONSUMER_GROUPS.searchIndexWorker,
  topics: ['posts', 'social'],
  metricsPort: env.METRICS_PORT,
  // Restart resume comes from the search checkpoints (seeks below); a
  // fresh group starts at the log end (reset epoch gate, ADR 0010).
  resetPause: { worker: 'search-index', valkeyUrl: env.VALKEY_URL },
  resumeFrom,
  handle: (envelope, raw) =>
    handleEvent(envelope, raw, {
      search,
      social,
      consumerKey: CONSUMER_GROUPS.searchIndexWorker,
    }),
});
