import { describe, expect, it, vi } from 'vitest';
import { MediaService } from './media.service.js';
import type { MediaEvents } from './media-events.js';
import type { MediaRepository, MediaRow } from './media.repository.js';
import type { MediaStorage } from './storage.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';

const row = (overrides: Partial<MediaRow> = {}): MediaRow => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  ownerId: OWNER,
  status: 'ready',
  objectKey: `${OWNER}/00000000-0000-4000-8000-0000000000c1/original.png`,
  mimeType: 'image/png',
  bytes: 1024,
  variants: [
    {
      kind: 'thumb',
      objectKey: `${OWNER}/00000000-0000-4000-8000-0000000000c1/thumb.webp`,
      mimeType: 'image/webp',
      bytes: 256,
      width: 64,
      height: 64,
    },
  ],
  attempts: 0,
  uploadedAt: new Date('2026-08-18T00:00:00Z'),
  createdAt: new Date('2026-08-18T00:00:00Z'),
  ...overrides,
});

function makeService() {
  const audits: { actorId: string; actorName: string; action: string; targetId: string }[] = [];
  const repo = {
    find: vi.fn(() => Promise.resolve(null as MediaRow | null)),
    adminMedia: vi.fn(() => Promise.resolve({ items: [] as MediaRow[], nextCursor: null })),
    adminDelete: vi.fn(
      (
        id: string,
        actor: { actorId: string; actorName: string; action: string; targetId: string },
      ): Promise<MediaRow | null> => {
        audits.push(actor);
        return Promise.resolve(row({ id }));
      },
    ),
    adminAudit: vi.fn(() => Promise.resolve({ items: audits, nextCursor: null })),
  };
  const removed: string[] = [];
  const storage: MediaStorage = {
    presignPut: vi.fn(),
    head: vi.fn(),
    get: vi.fn(),
    put: vi.fn(),
    remove: vi.fn((objectKey: string) => {
      removed.push(objectKey);
      return Promise.resolve();
    }),
  };
  const service = new MediaService(
    repo as unknown as MediaRepository,
    storage,
    { emit: vi.fn(), shutdown: vi.fn() } as unknown as MediaEvents,
  );
  return { repo, storage, removed, audits, service };
}

const ADMIN = { actorId: 'localadmin-uuid', actorName: 'localadmin' };

describe('MediaService admin moderation', () => {
  it('passes owner/status filters through to the repository', async () => {
    const { repo, service } = makeService();
    await service.adminList({ ownerId: OWNER, status: 'ready', limit: 10 });
    expect(repo.adminMedia).toHaveBeenCalledWith({ ownerId: OWNER, status: 'ready' }, undefined, 10);
  });

  it('rejects a malformed cursor with 400', async () => {
    const { service } = makeService();
    await expect(service.adminList({ cursor: '###', limit: 20 })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('deletes the row with an audit entry, then removes original AND variant objects', async () => {
    const { repo, removed, audits, service } = makeService();
    await service.adminDelete(ADMIN, '00000000-0000-4000-8000-0000000000c1');

    expect(repo.adminDelete).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-0000000000c1',
      expect.objectContaining({ action: 'media.delete', actorName: 'localadmin' }),
    );
    expect(audits).toHaveLength(1);
    // RustFS cascade: every object key the asset owns, not just the original.
    expect(removed).toEqual([
      '00000000-0000-4000-8000-0000000000a1/00000000-0000-4000-8000-0000000000c1/original.png',
      '00000000-0000-4000-8000-0000000000a1/00000000-0000-4000-8000-0000000000c1/thumb.webp',
    ]);
  });

  it('404s when the asset does not exist and touches no objects', async () => {
    const { repo, removed, service } = makeService();
    repo.adminDelete.mockResolvedValueOnce(null);
    await expect(service.adminDelete(ADMIN, 'missing')).rejects.toMatchObject({ status: 404 });
    expect(removed).toEqual([]);
  });

  it('survives an object-store failure during cleanup (row + audit already committed)', async () => {
    const { storage, service } = makeService();
    (storage.remove as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rustfs down'));
    await expect(service.adminDelete(ADMIN, '00000000-0000-4000-8000-0000000000c1')).resolves.toBe(
      undefined,
    );
  });
});
