import {
  crossServiceUrlSchema,
  kafkaBrokers,
  localPort,
  localUrl,
  valkeyUrl,
} from '@xitter/config';
import { z } from 'zod';

/**
 * Media-process worker env. Parsed in main.ts; kept side-effect free (no
 * loadRepoEnv, no worker boot) so the schema is unit-testable.
 */
export const envSchema = z.object({
  KAFKA_BROKERS: z.string().min(1).default(kafkaBrokers()),
  // Cross-service URL: localhost locally, REQUIRED when deployed (#113).
  MEDIA_INTERNAL_URL: crossServiceUrlSchema('MEDIA_INTERNAL_URL', 'media'),
  METRICS_PORT: z.coerce.number().int().positive().default(localPort('mediaProcessMetrics')),
  KEYCLOAK_BASE_URL: z.string().url().default(localUrl('keycloak')),
  DEMO_REALM: z.string().min(1).default('xitter-demo'),
  KEYCLOAK_CLIENT_ID: z.string().min(1).default('svc-worker-media-process'),
  KEYCLOAK_CLIENT_SECRET: z.string().min(1).default('svc-worker-media-process-local-secret'),
  // RustFS storage wiring (dependency, not a service URL - local default
  // stays in every env).
  XITTER_MEDIA_S3_ENDPOINT: z.string().url().default(localUrl('rustfs')),
  XITTER_MEDIA_S3_BUCKET: z.string().min(1).default('xitter-media'),
  XITTER_MEDIA_S3_ACCESS_KEY: z.string().min(1).default('xitter-local'),
  XITTER_MEDIA_S3_SECRET_KEY: z.string().min(1).default('xitter-local-secret'),
  VALKEY_URL: z.string().url().default(valkeyUrl()),
});
