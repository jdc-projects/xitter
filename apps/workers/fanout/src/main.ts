/**
 * Fanout worker: turns posts/social events into materialised feed entries
 * (ADR 0003). Deployed as a Knative service; consumes Kafka only and calls
 * back through the services' internal APIs.
 */
import { realmUrls } from '@xitter/auth';
import { FeedClient, PostsClient, SocialClient } from '@xitter/api-client';
import { kafkaBrokers, localPort, localUrl, loadRepoEnv, parseEnv } from '@xitter/config';
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
  }),
);

// Internal clients build /api/{service}/internal/... from the bare base URL
// (mirrors media-process); M2M tokens carry the scoped audiences
// (svc-social, svc-posts, svc-feed - packages/auth clients.ts).
const internal = {
  tokenUrl: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).token,
  clientId: env.KEYCLOAK_CLIENT_ID,
  clientSecret: env.KEYCLOAK_CLIENT_SECRET,
};

await runEventWorker({
  service: 'fanout-worker',
  clientId: 'xitter-fanout-worker',
  brokers: env.KAFKA_BROKERS.split(','),
  groupId: CONSUMER_GROUPS.fanoutWorker,
  topics: ['posts', 'social'],
  metricsPort: env.METRICS_PORT,
  handle: (envelope) =>
    handleEvent(envelope, {
      social: new SocialClient({ baseUrl: env.SOCIAL_INTERNAL_URL, internal }),
      posts: new PostsClient({ baseUrl: env.POSTS_INTERNAL_URL, internal }),
      feed: new FeedClient({ baseUrl: env.FEED_INTERNAL_URL, internal }),
    }),
});
