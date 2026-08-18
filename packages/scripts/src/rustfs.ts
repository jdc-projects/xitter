#!/usr/bin/env tsx
/**
 * RustFS bucket bootstrap: create `xitter-media` (public read) and set CORS
 * so browsers can presigned-PUT from any local origin (port offsets make
 * pinning origins futile; the bucket holds only disposable demo media).
 * Idempotent - safe to re-run (part of bootstrap).
 */
import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { localPort, localUrl, loadRepoEnv } from '@xitter/config';

loadRepoEnv();

const BUCKET = process.env.XITTER_MEDIA_S3_BUCKET ?? 'xitter-media';
const ENDPOINT = process.env.XITTER_MEDIA_S3_ENDPOINT ?? localUrl('rustfs');
// Compose defaults (infra/docker/compose.yaml) - non-secret local values.
const ACCESS_KEY = process.env.XITTER_MEDIA_S3_ACCESS_KEY ?? 'xitter-local';
const SECRET_KEY = process.env.XITTER_MEDIA_S3_SECRET_KEY ?? 'xitter-local-secret';

const client = new S3Client({
  endpoint: ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED' as const,
  responseChecksumValidation: 'WHEN_REQUIRED' as const,
});

// Anonymous download policy - what `mc anonymous set download` writes on dev.
const PUBLIC_READ_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Effect: 'Allow',
      Principal: '*',
      Action: ['s3:GetObject'],
      Resource: [`arn:aws:s3:::${BUCKET}/*`],
    },
  ],
};

// Presigned PUTs are cross-origin from the web/edge origin to RustFS's port.
const CORS_RULES = {
  CORSRules: [
    {
      AllowedOrigins: ['*'],
      AllowedMethods: ['GET', 'PUT', 'POST', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3000,
    },
  ],
};

// RustFS answers TCP before its S3 API; retry like the dev provision job.
const deadline = Date.now() + 60_000;
for (;;) {
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    break;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('BucketAlreadyOwnedByYou')) break;
    if (Date.now() > deadline) throw err;
    process.stdout.write(`waiting for rustfs (${ENDPOINT})...\n`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

await client.send(
  new PutBucketPolicyCommand({ Bucket: BUCKET, Policy: JSON.stringify(PUBLIC_READ_POLICY) }),
);
await client.send(new PutBucketCorsCommand({ Bucket: BUCKET, CORSConfiguration: CORS_RULES }));

console.log(`rustfs: bucket ${BUCKET} ready (public read, cors open) on ${localPort('rustfs')}`);
