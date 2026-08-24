/**
 * Fanout worker: turns posts/social events into materialised feed entries
 * (ADR 0003). Deployed as a Knative service; consumes Kafka only and calls
 * back through the services' internal APIs.
 */
import { FeedClient, internalCredentials, PostsClient, SocialClient } from '@xitter/api-client';
import {
  kafkaBrokers,
  localPort,
  localUrl,
  loadRepoEnv,
  parseEnv,
  valkeyUrl,
} from '@xitter/config';
import { CONSUMER_GROUPS, runEventWorker } from '@xitter/events';
import { z } from 'zod';
import { handleEvent } from './handlers.js';

loadRepoEnv();

const env = parseEnv(
  z.object({
    KAFKA_BROKERS: z.string().min(1).default(kafkaBrokers()),
    FEED_INTERNAL_URL: z.string().url().default(localUrl('feed')),
    SOCIAL_INTERNAL_URL: z.string().url().default(localUrl('social')),
    POSTS_INTERNAL_URL: z.string().url().default(localUrl('posts')),
    METRICS_PORT: z.coerce.number().int().positive().default(localPort('fanoutMetrics')),
    KEYCLOAK_BASE_URL: z.string().url().default(localUrl('keycloak')),
    DEMO_REALM: z.string().min(1).default('xitter-demo'),
    KEYCLOAK_CLIENT_ID: z.string().min(1).default('svc-worker-fanout'),
    KEYCLOAK_CLIENT_SECRET: z.string().min(1).default('svc-worker-fanout-local-secret'),
    VALKEY_URL: z.string().url().default(valkeyUrl()),
  }),
);

// Internal clients build /api/{service}/internal/... from the bare base URL
// (mirrors media-process); M2M tokens carry the scoped audiences
// (svc-social, svc-posts, svc-feed - packages/auth clients.ts).
const internal = internalCredentials(env);

// Constructed once: each client instance owns its JWT cache, so per-event
// construction would fetch a fresh Keycloak token per message.
const social = new SocialClient({ baseUrl: env.SOCIAL_INTERNAL_URL, internal });
const posts = new PostsClient({ baseUrl: env.POSTS_INTERNAL_URL, internal });
const feed = new FeedClient({ baseUrl: env.FEED_INTERNAL_URL, internal });

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
  metricsPort: env.METRICS_PORT,
  handle: (envelope) => handleEvent(envelope, { social, posts, feed }),
});
