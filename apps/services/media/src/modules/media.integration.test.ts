import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { startPostgres, startRustfs } from '@xitter/testing';
import type { MediaAsset } from '@xitter/api-contracts';
import type { MediaEvents } from './media-events.js';
import { MediaRepository, type MediaPrismaClient } from './media.repository.js';
import { MediaService } from './media.service.js';
import { RustFsStorage, type MediaStorage } from './storage.js';

/**
 * Integration suite (testcontainers RustFS + Postgres): the REAL presign →
 * browser-PUT → HEAD-verified complete lifecycle, against the same RustFS
 * image the local stack runs. Skips in Stryker's sandbox (no generated
 * Prisma client there).
 */
const hasGeneratedClient = existsSync(join(process.cwd(), 'src/generated/prisma/client.ts'));

const OWNER = '00000000-0000-4000-8000-000000000901';

/** 2x4 transparent PNG. */
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000002000000020806000000f0e7f2b40000000c4944415408d763f8cfc0f01f0005050202b9cdc8600000000049454e44ae426082',
  'hex',
);

describe.skipIf(!hasGeneratedClient)('media integration (testcontainers rustfs + postgres)', () => {
  let db: MediaPrismaClient;
  let pool: Pool;
  let postgres: Awaited<ReturnType<typeof startPostgres>>;
  let rustfs: Awaited<ReturnType<typeof startRustfs>>;
  let storage: MediaStorage;
  let service: MediaService;
  const emitted: [string, Record<string, unknown>][] = [];
  let events: MediaEvents;

  beforeAll(async () => {
    const generated = await import('../generated/prisma/client.js');
    [postgres, rustfs] = await Promise.all([startPostgres('media-test'), startRustfs()]);

    const migration = readFileSync(
      join(process.cwd(), 'prisma/migrations/20260818000000_init/migration.sql'),
      'utf8',
    );
    pool = new Pool({ connectionString: postgres.connectionString });
    for (const statement of migration.split(/;\s*\n/).filter((s) => s.trim().length > 0)) {
      await pool.query(statement);
    }

    db = new generated.PrismaClient({
      adapter: new PrismaPg({ connectionString: postgres.connectionString }),
    }) as MediaPrismaClient;

    storage = new RustFsStorage({
      endpoint: rustfs.endpoint,
      publicEndpoint: rustfs.endpoint,
      region: 'us-east-1',
      bucket: 'xitter-media',
      accessKeyId: rustfs.accessKey,
      secretAccessKey: rustfs.secretKey,
    });

    // RustFS answers TCP before S3; createBucket retries until the API is up.
    const admin = new S3Client({
      endpoint: rustfs.endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId: rustfs.accessKey,
        secretAccessKey: rustfs.secretKey,
      },
      forcePathStyle: true,
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await admin.send(new CreateBucketCommand({ Bucket: 'xitter-media' }));
        break;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }

    events = {
      emit(eventType, payload) {
        emitted.push([eventType, payload]);
        return Promise.resolve();
      },
      shutdown: () => Promise.resolve(),
    };

    service = new MediaService(new MediaRepository(db), storage, events);
  }, 180_000);

  afterAll(async () => {
    await db?.$disconnect().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await rustfs?.stop();
    await postgres?.stop();
  });

  it('runs the full lifecycle: slot → presigned PUT → complete → variants → ready', async () => {
    const slot = await service.createUpload(OWNER, {
      mimeType: 'image/png',
      bytes: PNG_BYTES.length,
    });
    expect(slot.uploadUrl).toContain('/xitter-media/');
    expect(slot.uploadUrl).toContain('X-Amz-Signature');

    // The "browser": plain PUT with the declared content type, no SDK.
    const put = await fetch(slot.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: PNG_BYTES,
    });
    expect(put.status).toBe(200);

    // Completion before the PUT would 400 and emit nothing (HEAD miss).
    // (Here the PUT succeeded, so complete emits the uploaded event.)
    await expect(service.complete(OWNER, slot.mediaId)).resolves.toMatchObject({
      status: 'pending',
    });
    expect(emitted).toContainEqual([
      'media.media.uploaded',
      expect.objectContaining({ mediaId: slot.mediaId, bytes: PNG_BYTES.length }),
    ]);

    // Worker callback: record variants → ready.
    const asset = await service.recordVariants(slot.mediaId, [
      {
        kind: 'original',
        objectKey: `${OWNER}/${slot.mediaId}/original.png`,
        mimeType: 'image/png',
        bytes: PNG_BYTES.length,
        width: 2,
        height: 2,
      },
      {
        kind: 'thumb',
        objectKey: `${OWNER}/${slot.mediaId}/thumb.png`,
        mimeType: 'image/png',
        bytes: 100,
        width: 2,
        height: 2,
      },
    ]);
    expect(asset.status).toBe('ready');
    expect(asset.variants[0]).toMatchObject({
      url: `/media/${OWNER}/${slot.mediaId}/original.png`,
    });

    // Redelivery is idempotent: no second processed event, asset unchanged.
    await service.recordVariants(slot.mediaId, []);
    expect(emitted.filter(([type]) => type === 'media.media.processed')).toHaveLength(1);
  });

  it('rejects completion when the object was never uploaded', async () => {
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 10 });
    await expect(service.complete(OWNER, slot.mediaId)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects and deletes objects stored as a non-image content type', async () => {
    const slot = await service.createUpload(OWNER, {
      mimeType: 'image/png',
      bytes: PNG_BYTES.length,
    });
    // The presigner signs only the host, so a hostile client can PUT with an
    // arbitrary content type; completion must catch it server-side.
    const put = await fetch(slot.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'text/html' },
      body: '<script>alert(1)</script>',
    });
    expect(put.status).toBe(200);

    await expect(service.complete(OWNER, slot.mediaId)).rejects.toMatchObject({ status: 400 });

    // The asset is failed and the object is gone (public bucket hygiene).
    const after = await service.getMedia(slot.mediaId);
    expect(after.status).toBe('failed');
    expect(await storage.head(`${OWNER}/${slot.mediaId}/original.png`)).toBeNull();
  });

  it('reads back the object bytes via the storage seam', async () => {
    const slot = await service.createUpload(OWNER, {
      mimeType: 'image/png',
      bytes: PNG_BYTES.length,
    });
    await fetch(slot.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: PNG_BYTES,
    });
    const stored = await storage.get(`${OWNER}/${slot.mediaId}/original.png`);
    expect(Buffer.from(stored)).toEqual(PNG_BYTES);
  });

  it('failure reports cap out at failed and lookup filters by owner', async () => {
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 10 });
    const first = await service.reportFailure(slot.mediaId, 'boom');
    expect(first.status).toBe('pending');
    await service.reportFailure(slot.mediaId, 'boom');
    const third = await service.reportFailure(slot.mediaId, 'boom');
    expect(third.status).toBe('failed');

    const found = await service.lookup(OWNER, [slot.mediaId]);
    expect(found.map((a: MediaAsset) => a.id)).toEqual([slot.mediaId]);
    expect(await service.lookup('00000000-0000-4000-8000-000000000902', [slot.mediaId])).toEqual(
      [],
    );
  });
});
