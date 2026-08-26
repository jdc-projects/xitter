import { z } from 'zod';
import { crossServiceUrlSchema, parseEnv, serviceEnvSchema } from '@xitter/config';

// Posts extends the shared service env with the social + media M2M wiring:
// the service calls social's internal relationship endpoint before accepting
// a replyToId (block enforcement) and media's internal lookup before
// attaching mediaIds (existence + ownership + ready, spec 03). Credentials
// come from Keycloak: locally the realm provisioner pins
// `<client>-local-secret`; in-cluster the deploy injects the real secret
// (infra workloads.tf secret_env).
export const env = parseEnv(
  serviceEnvSchema('posts').extend({
    KEYCLOAK_CLIENT_ID: z.string().min(1).default('svc-posts'),
    KEYCLOAK_CLIENT_SECRET: z.string().min(1).default('svc-posts-local-secret'),
    // Cross-service URLs: localhost locally, REQUIRED when deployed (#113) -
    // the missing XITTER_MEDIA_URL here was #112's days-long 503 hunt.
    XITTER_SOCIAL_URL: crossServiceUrlSchema('XITTER_SOCIAL_URL', 'social'),
    XITTER_MEDIA_URL: crossServiceUrlSchema('XITTER_MEDIA_URL', 'media'),
  }),
);
