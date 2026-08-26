import {
  crossServiceUrlSchema,
  kafkaBrokers,
  localPort,
  localUrl,
  valkeyUrl,
} from '@xitter/config';
import { z } from 'zod';

/**
 * Fanout worker env. Parsed in main.ts; kept side-effect free (no
 * loadRepoEnv, no worker boot) so the schema is unit-testable.
 */
export const envSchema = z.object({
  KAFKA_BROKERS: z.string().min(1).default(kafkaBrokers()),
  // Cross-service URLs: localhost locally, REQUIRED when deployed (#113).
  FEED_INTERNAL_URL: crossServiceUrlSchema('FEED_INTERNAL_URL', 'feed'),
  SOCIAL_INTERNAL_URL: crossServiceUrlSchema('SOCIAL_INTERNAL_URL', 'social'),
  POSTS_INTERNAL_URL: crossServiceUrlSchema('POSTS_INTERNAL_URL', 'posts'),
  METRICS_PORT: z.coerce.number().int().positive().default(localPort('fanoutMetrics')),
  KEYCLOAK_BASE_URL: z.string().url().default(localUrl('keycloak')),
  DEMO_REALM: z.string().min(1).default('xitter-demo'),
  KEYCLOAK_CLIENT_ID: z.string().min(1).default('svc-worker-fanout'),
  KEYCLOAK_CLIENT_SECRET: z.string().min(1).default('svc-worker-fanout-local-secret'),
  VALKEY_URL: z.string().url().default(valkeyUrl()),
});
