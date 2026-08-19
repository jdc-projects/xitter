import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

/** How long a presigned PUT stays usable after slot creation. */
const PRESIGN_EXPIRY_SECONDS = 15 * 60;

/** DI token for the storage seam (tests provide their own). */
export const MEDIA_STORAGE = 'MEDIA_STORAGE';

export interface ObjectStat {
  bytes: number;
  contentType?: string;
}

/**
 * Storage seam so tests (and any future store swap) never need RustFS.
 * The service only ever uses object keys - the bucket is fixed config.
 */
export interface MediaStorage {
  /**
   * Presigned PUT the browser sends bytes to. Note: the SDK presigner signs
   * only `host` - the content type is advisory on the wire, so completion
   * re-checks the STORED content type before accepting the upload.
   */
  presignPut(objectKey: string, mimeType: string): Promise<string>;
  /** HEAD the exact key - completion verification never trusts the client. */
  head(objectKey: string): Promise<ObjectStat | null>;
  get(objectKey: string): Promise<Uint8Array>;
  put(objectKey: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Best-effort object delete (rejected uploads, cleanup). */
  remove(objectKey: string): Promise<void>;
}

export interface RustFsStorageOptions {
  /** Server-side endpoint (service → RustFS). */
  endpoint: string;
  /** Browser-facing endpoint used for presigning (SigV4 signs the host). */
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class RustFsStorage implements MediaStorage {
  private readonly client: S3Client;
  private readonly presignClient: S3Client;

  constructor(private readonly options: RustFsStorageOptions) {
    const base = {
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: true,
      // Streaming-unsigned-payload checksums (SDK default since 3.729) are an
      // AWS-only trailer feature; WHEN_REQUIRED keeps requests compatible
      // with S3-compatible stores and keeps presigned PUTs header-free so a
      // plain browser fetch can satisfy them.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.client = new S3Client({ ...base, endpoint: options.endpoint });
    this.presignClient = new S3Client({ ...base, endpoint: options.publicEndpoint });
  }

  async presignPut(objectKey: string, mimeType: string): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: objectKey,
        ContentType: mimeType,
      }),
      { expiresIn: PRESIGN_EXPIRY_SECONDS },
    );
  }

  async head(objectKey: string): Promise<ObjectStat | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
      );
      return { bytes: head.ContentLength ?? 0, contentType: head.ContentType };
    } catch (err) {
      if ((err as { name?: string }).name === 'NotFound') return null;
      throw err;
    }
  }

  async get(objectKey: string): Promise<Uint8Array> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
    );
    return new Uint8Array(await res.Body!.transformToByteArray());
  }

  async put(objectKey: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.options.bucket,
        Key: objectKey,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async remove(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.options.bucket, Key: objectKey }),
    );
  }
}
