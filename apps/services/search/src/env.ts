import { crossServiceUrlSchema, localUrl, parseEnv, serviceEnvSchema } from '@xitter/config';
import { z } from 'zod';

export const env = parseEnv(
  serviceEnvSchema('search').extend({
    // Dependency wiring (OpenSearch) keeps its local default in every env -
    // same class as DATABASE_URL/KAFKA_BROKERS/VALKEY_URL, not a
    // service-to-service URL (judged out of #113's strictness scope).
    XITTER_OPENSEARCH_URL: z.string().url().default(localUrl('opensearch')),
    // Hydration targets (posts/social internal lookups - spec 03):
    // localhost locally, REQUIRED when deployed (#113).
    XITTER_POSTS_URL: crossServiceUrlSchema('XITTER_POSTS_URL', 'posts'),
    XITTER_SOCIAL_URL: crossServiceUrlSchema('XITTER_SOCIAL_URL', 'social'),
    // M2M credentials for the hydration calls (audience svc-posts/svc-social).
    KEYCLOAK_CLIENT_ID: z.string().min(1).default('svc-search'),
    KEYCLOAK_CLIENT_SECRET: z.string().min(1).default('svc-search-local-secret'),
  }),
);
