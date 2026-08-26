import { describe, expect, it } from 'vitest';
import { MEDIA_MAX_BYTES } from '@xitter/api-contracts';
import { MAX_PROCESS_ATTEMPTS, MediaService } from './media.service.js';
import type { MediaEvents } from './media-events.js';
import type { MediaRepository, MediaRow, MediaVariantRecord } from './media.repository.js';
import type { MediaStorage } from './storage.js';
import type { AllowedMimeType } from './keys.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

const row = (overrides: Partial<MediaRow> = {}): MediaRow => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  ownerId: OWNER,
  status: 'pending',
  objectKey: `${OWNER}/00000000-0000-4000-8000-0000000000c1/original.png`,
  mimeType: 'image/png',
  bytes: 1024,
  variants: [],
  attempts: 0,
  uploadedAt: null,
  createdAt: new Date('2026-08-18T00:00:00Z'),
  ...overrides,
});

function makeDeps(
  statBytes: number | null = 1024,
  statContentType: string | undefined = 'image/png',
  options: { removeFails?: boolean } = {},
) {
  const rows = new Map<string, MediaRow>();
  const emitted: [string, Record<string, unknown>][] = [];
  const presigned: { objectKey: string; mimeType: string }[] = [];
  const removed: string[] = [];

  const repo = {
    find: (id: string) => Promise.resolve(rows.get(id) ?? null),
    findByIds: (ids: string[]) =>
      Promise.resolve(ids.flatMap((id) => (rows.get(id) ? [rows.get(id)!] : []))),
    create: (input: Parameters<MediaRepository['create']>[0]) => {
      const created = row({ ...input });
      rows.set(created.id, created);
      return Promise.resolve(created);
    },
    markUploaded: (id: string, bytes: number) => {
      const updated = { ...rows.get(id)!, uploadedAt: new Date(), bytes };
      rows.set(id, updated);
      return Promise.resolve(updated);
    },
    markFailed: (id: string) => {
      const updated = { ...rows.get(id)!, status: 'failed' };
      rows.set(id, updated);
      return Promise.resolve(updated);
    },
    recordVariants: (id: string, variants: MediaVariantRecord[]) => {
      const updated = { ...rows.get(id)!, status: 'ready', variants };
      rows.set(id, updated);
      return Promise.resolve(updated);
    },
    recordAttempt: (id: string, failed: boolean) => {
      const found = rows.get(id)!;
      const updated = {
        ...found,
        attempts: found.attempts + 1,
        ...(failed ? { status: 'failed' } : {}),
      };
      rows.set(id, updated);
      return Promise.resolve(updated);
    },
    truncate: () => {
      rows.clear();
      return Promise.resolve(0);
    },
  } as unknown as MediaRepository;

  const storage: MediaStorage = {
    presignPut: (objectKey, mimeType) => {
      presigned.push({ objectKey, mimeType });
      return Promise.resolve(`http://rustfs.test/${objectKey}?sig`);
    },
    head: () =>
      Promise.resolve(
        statBytes === null ? null : { bytes: statBytes, contentType: statContentType },
      ),
    get: () => Promise.resolve(new Uint8Array()),
    put: () => Promise.resolve(),
    remove: (objectKey) => {
      removed.push(objectKey);
      // Object cleanup is best-effort: a failing RustFS must not turn the
      // rejection/cap transition into a 500 (the bucket wipe catches up).
      if (options.removeFails) return Promise.reject(new Error('rustfs down'));
      return Promise.resolve();
    },
  };

  const events: MediaEvents & { emitted: [string, Record<string, unknown>][] } = {
    emitted,
    emit(eventType, payload) {
      emitted.push([eventType, payload]);
      return Promise.resolve();
    },
    shutdown: () => Promise.resolve(),
  };

  return {
    service: new MediaService(repo, storage, events),
    rows,
    repo,
    events,
    emitted,
    presigned,
    removed,
  };
}

const validVariant: MediaVariantRecord = {
  kind: 'original',
  objectKey: `${OWNER}/00000000-0000-4000-8000-0000000000c1/original.png`,
  mimeType: 'image/png',
  bytes: 1024,
  width: 100,
  height: 50,
};

describe('createUpload (slot limits + key layout)', () => {
  it('creates a pending asset with a presigned PUT for the exact key', async () => {
    const { service, rows, presigned } = makeDeps();

    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 2048 });

    expect(rows.get(slot.mediaId)).toMatchObject({
      ownerId: OWNER,
      status: 'pending',
      bytes: 2048,
      objectKey: `${OWNER}/${slot.mediaId}/original.png`,
    });
    expect(slot.uploadUrl).toContain('/original.png');
    expect(presigned).toEqual([
      { objectKey: `${OWNER}/${slot.mediaId}/original.png`, mimeType: 'image/png' },
    ]);
  });

  it('rejects non-allowlisted mime types with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const { service } = makeDeps();
    await expect(
      service.createUpload(OWNER, { mimeType: 'image/svg+xml', bytes: 10 }),
    ).rejects.toMatchObject({
      status: 415,
      response: { error: { code: 'UNSUPPORTED_MEDIA_TYPE' } },
    });
  });

  it(`rejects declared sizes over ${MEDIA_MAX_BYTES} with 413 PAYLOAD_TOO_LARGE`, async () => {
    const { service } = makeDeps();
    await expect(
      service.createUpload(OWNER, { mimeType: 'image/png', bytes: MEDIA_MAX_BYTES + 1 }),
    ).rejects.toMatchObject({
      status: 413,
      response: { error: { code: 'PAYLOAD_TOO_LARGE' } },
    });
  });

  it.each(['png', 'jpg', 'webp', 'gif'] as const)(
    'keys %s objects by the data-platform layout',
    async (ext) => {
      const { service, rows } = makeDeps();
      const mime: Record<string, AllowedMimeType> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        webp: 'image/webp',
        gif: 'image/gif',
      };
      const slot = await service.createUpload(OWNER, {
        mimeType: mime[ext]!,
        bytes: 10,
      });
      expect(rows.get(slot.mediaId)!.objectKey.endsWith(`/original.${ext}`)).toBe(true);
    },
  );
});

describe('complete (server-side verification)', () => {
  it('emits media.uploaded only after HEAD confirms the object', async () => {
    const { service, emitted } = makeDeps(4096);
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    const asset = await service.complete(OWNER, slot.mediaId);

    expect(asset.status).toBe('pending'); // ready only after worker variants
    // The event carries the object's REAL size, not the client's claim.
    expect(emitted).toEqual([
      [
        'media.media.uploaded',
        expect.objectContaining({
          mediaId: slot.mediaId,
          ownerId: OWNER,
          bytes: 4096,
          objectKey: expect.stringContaining('/original.png'),
        }),
      ],
    ]);
  });

  it('refuses to emit when the object is absent (never trusts the client)', async () => {
    const { service, emitted } = makeDeps(null);
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    await expect(service.complete(OWNER, slot.mediaId)).rejects.toMatchObject({
      status: 400,
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
    expect(emitted).toHaveLength(0);
  });

  it('marks the asset failed and removes the object when the real size breaks the cap', async () => {
    const { service, rows, emitted, removed } = makeDeps(MEDIA_MAX_BYTES + 1);
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    await expect(service.complete(OWNER, slot.mediaId)).rejects.toMatchObject({ status: 400 });
    expect(rows.get(slot.mediaId)).toMatchObject({ status: 'failed' });
    expect(removed).toEqual([`${OWNER}/${slot.mediaId}/original.png`]);
    expect(emitted).toHaveLength(0);
  });

  it('rejects objects stored with a non-allowlisted content type', async () => {
    const { service, rows, removed } = makeDeps(1024, 'text/html');
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    await expect(service.complete(OWNER, slot.mediaId)).rejects.toMatchObject({ status: 400 });
    expect(rows.get(slot.mediaId)).toMatchObject({ status: 'failed' });
    expect(removed).toHaveLength(1);
  });

  it('rejects 0-byte objects - the empty PUT must not complete', async () => {
    const { service, rows, emitted, removed } = makeDeps(0);
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    await expect(service.complete(OWNER, slot.mediaId)).rejects.toMatchObject({ status: 400 });
    expect(rows.get(slot.mediaId)).toMatchObject({ status: 'failed' });
    expect(removed).toEqual([`${OWNER}/${slot.mediaId}/original.png`]);
    expect(emitted).toHaveLength(0);
  });

  it('still fails the upload when the rejected object cannot be removed', async () => {
    const { service, rows, emitted } = makeDeps(MEDIA_MAX_BYTES + 1, 'image/png', {
      removeFails: true,
    });
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    await expect(service.complete(OWNER, slot.mediaId)).rejects.toMatchObject({ status: 400 });
    expect(rows.get(slot.mediaId)).toMatchObject({ status: 'failed' });
    expect(emitted).toHaveLength(0);
  });

  it('is idempotent: a repeat complete does not re-emit the event', async () => {
    const { service, emitted } = makeDeps();
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    await service.complete(OWNER, slot.mediaId);
    await service.complete(OWNER, slot.mediaId);

    expect(emitted.filter(([type]) => type === 'media.media.uploaded')).toHaveLength(1);
  });

  it('404s for missing ids and for other users assets', async () => {
    const { service } = makeDeps();
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    await expect(
      service.complete(OWNER, '00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.complete(OTHER, slot.mediaId)).rejects.toMatchObject({ status: 404 });
  });

  it('rejects completing an asset that already failed processing', async () => {
    const { service, rows } = makeDeps();
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });
    rows.set(slot.mediaId, { ...rows.get(slot.mediaId)!, status: 'failed' });

    await expect(service.complete(OWNER, slot.mediaId)).rejects.toMatchObject({ status: 400 });
  });
});

describe('variant recording (worker callbacks)', () => {
  it('a failed event emission never fails the committed mutation', async () => {
    const deps = makeDeps();
    deps.events.emit = () => Promise.reject(new Error('kafka down'));
    const slot = await deps.service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    // markUploaded commits; the missed media.uploaded event only stalls the
    // asset in pending until the nightly reset.
    const asset = await deps.service.complete(OWNER, slot.mediaId);
    expect(asset.status).toBe('pending');
    expect(deps.rows.get(slot.mediaId)!.uploadedAt).toBeInstanceOf(Date);
    expect(deps.emitted).toHaveLength(0);
  });

  it('recordVariants commits ready even when the processed event cannot be emitted', async () => {
    const deps = makeDeps();
    deps.events.emit = () => Promise.reject(new Error('kafka down'));
    const slot = await deps.service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    const asset = await deps.service.recordVariants(slot.mediaId, [validVariant]);

    expect(asset.status).toBe('ready');
    expect(deps.rows.get(slot.mediaId)).toMatchObject({ status: 'ready' });
  });

  it('flips to ready, emits processed, and serves /media urls', async () => {
    const { service, emitted } = makeDeps();
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });
    await service.complete(OWNER, slot.mediaId);

    const asset = await service.recordVariants(slot.mediaId, [
      validVariant,
      {
        ...validVariant,
        kind: 'thumb',
        objectKey: `${OWNER}/${slot.mediaId}/thumb.png`,
        bytes: 100,
      },
    ]);

    expect(asset.status).toBe('ready');
    expect(asset.variants).toEqual([
      expect.objectContaining({ kind: 'original', url: `/media/${validVariant.objectKey}` }),
      expect.objectContaining({
        kind: 'thumb',
        url: `/media/${OWNER}/${slot.mediaId}/thumb.png`,
      }),
    ]);
    expect(emitted).toContainEqual(['media.media.processed', expect.any(Object)]);
  });

  it('is idempotent on redelivery: ready assets are untouched, no re-emit', async () => {
    const { service, emitted } = makeDeps();
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });
    await service.complete(OWNER, slot.mediaId);
    await service.recordVariants(slot.mediaId, [validVariant]);

    await service.recordVariants(slot.mediaId, [validVariant]);

    expect(emitted.filter(([type]) => type === 'media.media.processed')).toHaveLength(1);
  });

  it('caps processing attempts and reports the transition', async () => {
    const { service, rows } = makeDeps();
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    for (let attempt = 1; attempt < MAX_PROCESS_ATTEMPTS; attempt++) {
      const asset = await service.reportFailure(slot.mediaId, 'sharp exploded');
      expect(asset.status).toBe('pending');
    }
    const final = await service.reportFailure(slot.mediaId, 'sharp exploded');
    expect(final.status).toBe('failed');
    expect(rows.get(slot.mediaId)).toMatchObject({ attempts: MAX_PROCESS_ATTEMPTS });
  });

  it('removes the object when the attempt cap flips the asset to failed', async () => {
    const { service, removed } = makeDeps();
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    await service.reportFailure(slot.mediaId, 'sharp could not decode');
    expect(removed).toHaveLength(0); // still pending - object may yet process

    for (let attempt = 2; attempt <= MAX_PROCESS_ATTEMPTS; attempt++) {
      await service.reportFailure(slot.mediaId, 'sharp could not decode');
    }

    expect(removed).toEqual([`${OWNER}/${slot.mediaId}/original.png`]);
  });

  it('still flips to failed when the dead object cannot be removed', async () => {
    const { service, rows } = makeDeps(1024, 'image/png', { removeFails: true });
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    for (let attempt = 1; attempt <= MAX_PROCESS_ATTEMPTS; attempt++) {
      const asset = await service.reportFailure(slot.mediaId, 'sharp could not decode');
      expect(asset.status).toBe(attempt === MAX_PROCESS_ATTEMPTS ? 'failed' : 'pending');
    }
    expect(rows.get(slot.mediaId)).toMatchObject({
      status: 'failed',
      attempts: MAX_PROCESS_ATTEMPTS,
    });
  });
});

describe('getMedia (upload polling)', () => {
  it('404s for an asset id that never existed', async () => {
    const { service } = makeDeps();

    await expect(
      service.getMedia('00000000-0000-4000-8000-0000000000dd'),
    ).rejects.toMatchObject({ status: 404, response: { error: { code: 'NOT_FOUND' } } });
  });

  it('tracks the visible lifecycle: pending → uploaded (still pending) → ready', async () => {
    const { service } = makeDeps(2048);
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    // Slot granted, nothing PUT yet: polling already sees the asset.
    await expect(service.getMedia(slot.mediaId)).resolves.toMatchObject({
      id: slot.mediaId,
      ownerId: OWNER,
      status: 'pending',
      variants: [],
    });

    await service.complete(OWNER, slot.mediaId);
    // Uploaded but the worker has not converged: still pending, no variants.
    await expect(service.getMedia(slot.mediaId)).resolves.toMatchObject({ status: 'pending' });

    await service.recordVariants(slot.mediaId, [
      validVariant,
      {
        ...validVariant,
        kind: 'thumb',
        objectKey: `${OWNER}/${slot.mediaId}/thumb.png`,
        bytes: 100,
      },
    ]);

    const ready = await service.getMedia(slot.mediaId);
    expect(ready.status).toBe('ready');
    expect(ready.variants).toEqual([
      expect.objectContaining({ kind: 'original', url: `/media/${validVariant.objectKey}` }),
      expect.objectContaining({ kind: 'thumb', url: `/media/${OWNER}/${slot.mediaId}/thumb.png` }),
    ]);
    // The public poll view never leaks storage coordinates (internal only).
    expect(ready).not.toHaveProperty('objectKey');
  });

  it('reports failed once the worker attempt cap is exhausted', async () => {
    const { service } = makeDeps();
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });

    for (let attempt = 0; attempt < MAX_PROCESS_ATTEMPTS; attempt++) {
      await service.reportFailure(slot.mediaId, 'sharp exploded');
    }

    await expect(service.getMedia(slot.mediaId)).resolves.toMatchObject({ status: 'failed' });
  });

  it('404s mid-processing once the metadata is wiped (nightly reset)', async () => {
    const { service } = makeDeps();
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });
    await service.complete(OWNER, slot.mediaId);

    await expect(service.getMedia(slot.mediaId)).resolves.toMatchObject({ status: 'pending' });

    await service.reseed(); // the reset wipes metadata while the worker runs

    await expect(service.getMedia(slot.mediaId)).rejects.toMatchObject({ status: 404 });
  });
});

describe('getInternal (worker state reads)', () => {
  it('404s for an unknown asset id', async () => {
    const { service } = makeDeps();

    await expect(
      service.getInternal('00000000-0000-4000-8000-0000000000dd'),
    ).rejects.toMatchObject({ status: 404, response: { error: { code: 'NOT_FOUND' } } });
  });

  it('exposes the storage coordinates and attempt count the public view omits', async () => {
    const { service } = makeDeps(2048);
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 512 });
    await service.complete(OWNER, slot.mediaId);
    await service.reportFailure(slot.mediaId, 'transient sharp error');

    const internal = await service.getInternal(slot.mediaId);
    expect(internal).toMatchObject({
      id: slot.mediaId,
      status: 'pending', // one attempt in: the cap has not tripped yet
      objectKey: `${OWNER}/${slot.mediaId}/original.png`,
      mimeType: 'image/png',
      bytes: 2048, // the object's real size from the complete-time HEAD
      attempts: 1,
    });
  });
});

describe('lookup + reseed (internal)', () => {
  it('returns only the owner assets among the requested ids', async () => {
    const { service } = makeDeps();
    const mine = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 10 });
    const theirs = await service.createUpload(OTHER, { mimeType: 'image/png', bytes: 10 });

    const found = await service.lookup(OWNER, [
      mine.mediaId,
      theirs.mediaId,
      '00000000-0000-4000-8000-0000000000ee',
    ]);

    expect(found.map((asset) => asset.id)).toEqual([mine.mediaId]);
  });

  it('reseed wipes metadata', async () => {
    const { service, rows } = makeDeps();
    await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 10 });
    await service.reseed();
    expect(rows.size).toBe(0);
  });

  it('is idempotent: wiping an already-wiped set is a no-op', async () => {
    const { service, rows } = makeDeps();
    await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 10 });

    await service.reseed();
    await service.reseed();

    expect(rows.size).toBe(0);
  });
});

describe('reseed convergence (bucket wipe + seed re-upload)', () => {
  /** One seed fixture's full path: slot → complete → variants → ready. */
  async function seedOneAsset(service: MediaService) {
    const slot = await service.createUpload(OWNER, { mimeType: 'image/png', bytes: 2048 });
    await service.complete(OWNER, slot.mediaId);
    return service.recordVariants(slot.mediaId, [validVariant]);
  }

  it('re-uploading the same seed slot after a wipe converges to one ready asset', async () => {
    const { service, rows } = makeDeps();
    const first = await seedOneAsset(service);
    expect(rows.size).toBe(1);

    await service.reseed(); // nightly wipe between seed runs
    const second = await seedOneAsset(service);

    // Converged: exactly one asset for the re-uploaded fixture, ready again,
    // and the wiped id is gone from every read path.
    expect(rows.size).toBe(1);
    expect(second).toMatchObject({ status: 'ready', ownerId: OWNER });
    expect(second.id).not.toBe(first.id);
    await expect(service.getMedia(first.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.lookup(OWNER, [first.id])).resolves.toEqual([]);
  });
});
