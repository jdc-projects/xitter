import { localUrl, parseEnv, serviceEnvSchema } from '@xitter/config';
import { z } from 'zod';

export const env = parseEnv(
  serviceEnvSchema('search').extend({
    XITTER_OPENSEARCH_URL: z.string().url().default(localUrl('opensearch')),
    // Hydration targets (posts/social internal lookups - spec 03).
    XITTER_POSTS_URL: z.string().url().default(localUrl('posts')),
    XITTER_SOCIAL_URL: z.string().url().default(localUrl('social')),
    // M2M credentials for the hydration calls (audience svc-posts/svc-social).
    KEYCLOAK_CLIENT_ID: z.string().min(1).default('svc-search'),
    KEYCLOAK_CLIENT_SECRET: z.string().min(1).default('svc-search-local-secret'),
  }),
);
