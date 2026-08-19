import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { WorkerStorage } from './handlers.js';

/** RustFS get/put for the worker (no presigning happens here). */
export class RustFsWorkerStorage implements WorkerStorage {
  private readonly client: S3Client;

  constructor(options: {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  }) {
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: true,
      // AWS-only streaming checksum trailers must stay off against
      // S3-compatible stores (same rationale as the media service).
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    });
    this.bucket = options.bucket;
  }

  private readonly bucket: string;

  async get(objectKey: string): Promise<Uint8Array> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
    );
    return new Uint8Array(await res.Body!.transformToByteArray());
  }

  async put(objectKey: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }
}
