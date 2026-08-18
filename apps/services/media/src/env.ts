import { z } from 'zod';
import { localUrl, parseEnv, serviceEnvSchema } from '@xitter/config';

// RustFS wiring. S3_ENDPOINT is what this service talks to (HEAD/get/put);
// S3_PUBLIC_ENDPOINT is what the browser is presigned against - identical
// locally, different in-cluster where the service uses the in-cluster
// service URL while uploads must go through the edge host (SigV4 signs the
// host, so the presign host must equal the host the browser contacts).
// Credentials default to the compose stack's non-secret local values.
export const env = parseEnv(
  serviceEnvSchema('media').extend({
    XITTER_MEDIA_S3_ENDPOINT: z.string().url().default(localUrl('rustfs')),
    XITTER_MEDIA_S3_PUBLIC_ENDPOINT: z.string().url().default(localUrl('rustfs')),
    XITTER_MEDIA_S3_BUCKET: z.string().min(1).default('xitter-media'),
    XITTER_MEDIA_S3_ACCESS_KEY: z.string().min(1).default('xitter-local'),
    XITTER_MEDIA_S3_SECRET_KEY: z.string().min(1).default('xitter-local-secret'),
  }),
);
