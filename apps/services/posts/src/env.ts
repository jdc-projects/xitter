import { z } from 'zod';
import { localUrl, parseEnv, serviceEnvSchema } from '@xitter/config';

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
    XITTER_SOCIAL_URL: z.string().url().default(localUrl('social')),
    XITTER_MEDIA_URL: z.string().url().default(localUrl('media')),
  }),
);
