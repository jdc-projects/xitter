import { z } from 'zod';
import { crossServiceUrlSchema, parseEnv, serviceEnvSchema } from '@xitter/config';

// Feed extends the shared service env with the posts + social M2M wiring:
// reads hydrate post bodies and author profiles server-side (spec 03) and
// filter blocked authors, all through their internal endpoints. Credentials
// come from Keycloak: locally the realm provisioner pins
// `<client>-local-secret`; in-cluster the deploy injects the real secret
// (infra workloads.tf secret_env). Valkey carries ws pub/sub notifications
// (feed:updates:{userId}).
export const env = parseEnv(
  serviceEnvSchema('feed').extend({
    KEYCLOAK_CLIENT_ID: z.string().min(1).default('svc-feed'),
    KEYCLOAK_CLIENT_SECRET: z.string().min(1).default('svc-feed-local-secret'),
    // Cross-service URLs: localhost locally, REQUIRED when deployed (#113).
    XITTER_POSTS_URL: crossServiceUrlSchema('XITTER_POSTS_URL', 'posts'),
    XITTER_SOCIAL_URL: crossServiceUrlSchema('XITTER_SOCIAL_URL', 'social'),
  }),
);
