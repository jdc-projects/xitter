import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '@xitter/events';
import type { InternalMediaAsset, MediaAsset } from '@xitter/api-contracts';
import { handleEvent, type HandlerDeps, type MediaApi, type WorkerStorage } from './handlers.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const MEDIA_ID = '00000000-0000-4000-8000-0000000000b2';
const ORIGINAL_KEY = `${OWNER}/${MEDIA_ID}/original.png`;

const asset = (overrides: Partial<InternalMediaAsset> = {}): InternalMediaAsset => ({
  id: MEDIA_ID,
  ownerId: OWNER,
  status: 'pending',
  variants: [],
  createdAt: '2026-08-18T00:00:00.000Z',
  objectKey: ORIGINAL_KEY,
  mimeType: 'image/png',
  bytes: 3,
  attempts: 0,
  ...overrides,
});

const envelope = {
  eventId: '00000000-0000-4000-8000-0000000000c3',
  eventType: EVENT_TYPES.mediaUploaded,
  eventVersion: 1,
  producer: 'media',
  occurredAt: '2026-08-18T00:00:00.000Z',
  payload: { mediaId: MEDIA_ID, ownerId: OWNER },
};

function makeDeps(status: MediaAsset['status'], log: string[] = []) {
  const recorded: { mediaId: string; variants: unknown[] }[] = [];
  const failures: string[] = [];
  const puts: { objectKey: string; contentType: string }[] = [];

  const media: MediaApi = {
    internalGetAsset: () => Promise.resolve(asset({ status })),
    internalRecordVariants: (mediaId, variants) => {
      recorded.push({ mediaId, variants });
      log.push('record');
      return Promise.resolve(asset({ status: 'ready' }));
    },
    internalReportFailure: (mediaId, error) => {
      failures.push(error);
      log.push('fail');
      return Promise.resolve(asset({ status: 'pending' }));
    },
  };
  const storage: WorkerStorage = {
    get: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    put: (objectKey, _body, contentType) => {
      puts.push({ objectKey, contentType });
      return Promise.resolve();
    },
  };
  const derive: HandlerDeps['derive'] = async (original, input) => ({
    variants: [
      {
        kind: 'original',
        objectKey: input.objectKey,
        mimeType: input.mimeType,
        bytes: original.byteLength,
        width: 10,
        height: 10,
      },
      {
        kind: 'thumb',
        objectKey: input.objectKey.replace('original.', 'thumb.'),
        mimeType: input.mimeType,
        bytes: 5,
        width: 5,
        height: 5,
      },
    ],
    thumbBytes: new Uint8Array([9]),
  });
  return { deps: { media, storage, derive } as HandlerDeps, recorded, failures, puts, log };
}

describe('media-process handleEvent', () => {
  it('ignores non-upload events', async () => {
    const { deps } = makeDeps('pending');
    await expect(
      handleEvent({ eventType: EVENT_TYPES.postCreated }, deps),
    ).resolves.toBeUndefined();
  });

  it('skips events without a mediaId instead of throwing (poison-proof)', async () => {
    const { deps } = makeDeps('pending');
    await expect(handleEvent({ ...envelope, payload: {} }, deps)).resolves.toBeUndefined();
  });

  it('skips already-processed (ready) assets - idempotent redelivery', async () => {
    const { deps, recorded } = makeDeps('ready');
    await handleEvent(envelope, deps);
    expect(recorded).toHaveLength(0);
  });

  it('skips failed assets - retry cap terminates', async () => {
    const { deps, recorded } = makeDeps('failed');
    await handleEvent(envelope, deps);
    expect(recorded).toHaveLength(0);
  });

  it('skips when the asset vanished (reset raced the event)', async () => {
    const deps = {
      media: {
        internalGetAsset: () => Promise.reject(new Error('404')),
        internalRecordVariants: () => Promise.resolve(asset({ status: 'ready' })),
        internalReportFailure: () => Promise.resolve(asset()),
      },
      storage: { get: () => Promise.resolve(new Uint8Array()), put: () => Promise.resolve() },
    } as unknown as HandlerDeps;
    await expect(handleEvent(envelope, deps)).resolves.toBeUndefined();
  });

  it('processes a pending asset: thumb uploaded, variants recorded', async () => {
    const { deps, recorded, puts } = makeDeps('pending');

    await handleEvent(envelope, deps);

    expect(puts).toEqual([
      { objectKey: `${OWNER}/${MEDIA_ID}/thumb.png`, contentType: 'image/png' },
    ]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.variants).toEqual([
      expect.objectContaining({ kind: 'original', objectKey: ORIGINAL_KEY, bytes: 3 }),
      expect.objectContaining({ kind: 'thumb', objectKey: `${OWNER}/${MEDIA_ID}/thumb.png` }),
    ]);
  });

  it('reports failures and rethrows while the asset is still pending', async () => {
    const { deps, failures } = makeDeps('pending', []);
    (deps.storage as WorkerStorage).get = () => Promise.reject(new Error('rustfs down'));

    await expect(handleEvent(envelope, deps)).rejects.toThrow('rustfs down');
    expect(failures).toEqual(['rustfs down']);
  });

  it('swallows the error once the report says the cap was reached', async () => {
    const media: MediaApi = {
      internalGetAsset: () => Promise.resolve(asset()),
      internalRecordVariants: () => Promise.resolve(asset({ status: 'ready' })),
      internalReportFailure: () => Promise.resolve(asset({ status: 'failed' })),
    };
    const deps = {
      media,
      storage: {
        get: () => Promise.reject(new Error('corrupt bytes')),
        put: () => Promise.resolve(),
      },
    } as unknown as HandlerDeps;

    await expect(handleEvent(envelope, deps)).resolves.toBeUndefined();
  });

  it('rethrows the processing error when the failure report itself fails', async () => {
    const media: MediaApi = {
      internalGetAsset: () => Promise.resolve(asset()),
      internalRecordVariants: () => Promise.resolve(asset({ status: 'ready' })),
      internalReportFailure: () => Promise.reject(new Error('media unreachable')),
    };
    const deps = {
      media,
      storage: {
        get: () => Promise.reject(new Error('rustfs down')),
        put: () => Promise.resolve(),
      },
    } as unknown as HandlerDeps;

    await expect(handleEvent(envelope, deps)).rejects.toThrow('rustfs down');
  });
});
