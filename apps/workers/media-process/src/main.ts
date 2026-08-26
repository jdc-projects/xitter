/**
 * Media-process worker: generates image variants (original, thumb) with sharp
 * and reports them back to the media service. Deployed as a Knative service;
 * consumes Kafka only.
 */
import { realmUrls } from '@xitter/auth';
import { MediaClient } from '@xitter/api-client';
import { loadRepoEnv, parseEnv } from '@xitter/config';
import { CONSUMER_GROUPS, runEventWorker } from '@xitter/events';
import { handleEvent } from './handlers.js';
import { envSchema } from './env.js';
import { RustFsWorkerStorage } from './storage.js';

loadRepoEnv();

const env = parseEnv(envSchema);

const media = new MediaClient({
  baseUrl: env.MEDIA_INTERNAL_URL,
  internal: {
    tokenUrl: realmUrls(env.KEYCLOAK_BASE_URL, env.DEMO_REALM).token,
    clientId: env.KEYCLOAK_CLIENT_ID,
    clientSecret: env.KEYCLOAK_CLIENT_SECRET,
  },
});

const storage = new RustFsWorkerStorage({
  endpoint: env.XITTER_MEDIA_S3_ENDPOINT,
  region: 'us-east-1',
  bucket: env.XITTER_MEDIA_S3_BUCKET,
  accessKeyId: env.XITTER_MEDIA_S3_ACCESS_KEY,
  secretAccessKey: env.XITTER_MEDIA_S3_SECRET_KEY,
});

await runEventWorker({
  service: 'media-process-worker',
  clientId: 'xitter-media-process-worker',
  brokers: env.KAFKA_BROKERS.split(','),
  groupId: CONSUMER_GROUPS.mediaProcessWorker,
  topics: ['media'],
  // Derived-state builder over a RETAINED log: the reset epoch gate owns
  // start/resume positions (ADR 0010) - a fresh group starts at the log
  // end, and pre-reset media events are skipped when a reset clears (the
  // worker seeks to the end before resuming). Variants are only generated
  // for objects of the current epoch.
  resetPause: {
    worker: 'media-process',
    valkeyUrl: env.VALKEY_URL,
    brokers: env.KAFKA_BROKERS.split(','),
  },
  metricsPort: env.METRICS_PORT,
  handle: (envelope) => handleEvent(envelope, { media, storage }),
});
