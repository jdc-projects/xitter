/**
 * Fanout worker: turns posts/social events into materialised feed entries
 * (ADR 0003). Deployed as a Knative service; consumes Kafka only and calls
 * back through the services' internal APIs.
 *
 * Resume contract (#149): the nightly reset no longer deletes consumer
 * groups (ADR 0010) - the reset epoch gate pauses this worker and seeks it
 * to the log end around each wipe - but a restart OUTSIDE a reset (crash,
 * OOM, revision roll) must not skip the events produced while it was down.
 * The durable resume cursor (FeedCheckpoint in the feed DB, fetched at boot
 * via the feed internal API) repositions the worker exactly after the last
 * processed event; feed owns the store because fanout materialises feed's
 * data. A fresh boot with no checkpoints (first ever boot, or post-reset)
 * keeps the gate's fail-safe: seek to the log end, never replay an unknown
 * log.
 */
import { FeedClient, internalCredentials, PostsClient, SocialClient } from '@xitter/api-client';
import { loadRepoEnv, parseEnv } from '@xitter/config';
import { CONSUMER_GROUPS, runEventWorker } from '@xitter/events';
import { createLogger } from '@xitter/observability';
import { handleConsumedEvent } from './handlers.js';
import { envSchema } from './env.js';

const logger = createLogger({ service: 'fanout-worker' });

loadRepoEnv();

const env = parseEnv(envSchema);

// Internal clients build /api/{service}/internal/... from the bare base URL
// (mirrors media-process); M2M tokens carry the scoped audiences
// (svc-social, svc-posts, svc-feed - packages/auth clients.ts).
const internal = internalCredentials(env);

// Constructed once: each client instance owns its JWT cache, so per-event
// construction would fetch a fresh Keycloak token per message.
const social = new SocialClient({ baseUrl: env.SOCIAL_INTERNAL_URL, internal });
const posts = new PostsClient({ baseUrl: env.POSTS_INTERNAL_URL, internal });
const feed = new FeedClient({ baseUrl: env.FEED_INTERNAL_URL, internal });

// Resume positions (`topic:partition` -> next offset to consume). Fetched
// with patience (mirrors search-index): turbo starts services and workers
// in parallel, so the feed service may still be booting when we get here -
// an instant give-up lands the worker on the fresh-boot seek-to-end
// fail-safe and permanently skips whatever was produced while it was down.
// Retry until the service answers or the window closes; only genuine
// absence (empty result or a closed window) falls back to no resume
// positions.
const CHECKPOINT_FETCH_WINDOW_MS = 90_000;

async function fetchCheckpoints(): Promise<Map<string, number>> {
  const result = await feed.internalGetCheckpoints(CONSUMER_GROUPS.fanoutWorker);
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
  service: 'fanout-worker',
  clientId: 'xitter-fanout-worker',
  brokers: env.KAFKA_BROKERS.split(','),
  groupId: CONSUMER_GROUPS.fanoutWorker,
  topics: ['posts', 'social'],
  // Derived-state builder over a RETAINED log: the reset epoch gate owns
  // start/resume positions (ADR 0010) - a fresh group starts at the log
  // end (never replaying an unknown log), and a reset clears the backlog
  // by having this worker seek to the end before resuming. The materialised
  // feed therefore only ever holds events from the current epoch.
  resetPause: {
    worker: 'fanout',
    valkeyUrl: env.VALKEY_URL,
    brokers: env.KAFKA_BROKERS.split(','),
  },
  // Restart resume comes from the feed checkpoints: checkpointed partitions
  // are exempt from the fresh-boot seek-to-end (packages/events worker),
  // so downtime events are consumed, not skipped (#149).
  resumeFrom,
  metricsPort: env.METRICS_PORT,
  handle: (envelope, raw) =>
    handleConsumedEvent(envelope, raw, {
      social,
      posts,
      feed,
      consumerKey: CONSUMER_GROUPS.fanoutWorker,
    }),
});
