import { describe, expect, it, vi } from 'vitest';
import type { RequestUser } from '@xitter/auth-nest';
import { PostsService, type AdminActor } from './posts.service.js';
import type { PostsEvents } from './posts-events.js';
import type { PostsRepository, PostRow } from './posts.repository.js';
import type { MediaChecker } from './media-checker.js';
import type { RelationshipChecker } from './relationship-checker.js';

const AUTHOR = '00000000-0000-4000-8000-000000000a1';
const ADMIN: AdminActor = { actorId: 'localadmin-uuid', actorName: 'localadmin' };

const row = (overrides: Partial<PostRow> = {}): PostRow => ({
  id: '00000000-0000-4000-8000-000000000a01',
  authorId: AUTHOR,
  text: 'hello xitter',
  mediaIds: [],
  media: [],
  replyToId: null,
  repostOfId: null,
  createdAt: new Date('2026-08-17T00:00:00Z'),
  deletedAt: null,
  replyCount: 0,
  likeCount: 0,
  repostCount: 0,
  ...overrides,
});

interface AuditLike {
  actorId: string;
  actorName: string;
  action: string;
  targetId: string;
  detail?: Record<string, unknown> | null;
}

function fakeRepo() {
  const audits: AuditLike[] = [];
  const repo = {
    findPost: vi.fn(() => Promise.resolve(null as PostRow | null)),
    toCounts: (r: PostRow) => ({
      replies: r.replyCount,
      likes: r.likeCount,
      reposts: r.repostCount,
    }),
    adminPosts: vi.fn(() => Promise.resolve({ items: [] as PostRow[], nextCursor: null })),
    adminSoftDelete: vi.fn(
      (id: string, actor: { action: string } & AdminActor): Promise<PostRow | null> => {
        audits.push({ ...actor, targetId: id, detail: { hard: false } });
        return Promise.resolve(row({ id }));
      },
    ),
    adminHardDelete: vi.fn(
      (id: string, actor: { action: string } & AdminActor): Promise<PostRow | null> => {
        audits.push({ ...actor, targetId: id, detail: { hard: true } });
        return Promise.resolve(row({ id }));
      },
    ),
    adminRestore: vi.fn(
      (id: string, actor: { action: string } & AdminActor): Promise<PostRow | null> => {
        audits.push({ ...actor, targetId: id, detail: { hard: false } });
        return Promise.resolve(row({ id, deletedAt: null }));
      },
    ),
    adminAudit: vi.fn(() => Promise.resolve({ items: audits, nextCursor: null })),
  };
  return { repo, audits };
}

function spyEvents() {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    emit: (eventType: string, payload: Record<string, unknown>) => {
      calls.push([eventType, payload]);
      return Promise.resolve();
    },
    shutdown: () => Promise.resolve(),
  };
}

function makeService() {
  const { repo, audits } = fakeRepo();
  const events = spyEvents();
  const service = new PostsService(
    repo as unknown as PostsRepository,
    events as unknown as PostsEvents,
    {} as RelationshipChecker,
    {} as MediaChecker,
  );
  return { repo, audits, events, service };
}

describe('PostsService admin moderation', () => {
  it('passes author/text/deleted filters and the cursor straight to the repository', async () => {
    const { repo, service } = makeService();
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: '2026-08-17T00:00:00.000Z', id: row().id }),
    ).toString('base64url');
    await service.adminListPosts({
      authorId: AUTHOR,
      text: 'needle',
      deleted: 'true',
      cursor,
      limit: 5,
    });
    expect(repo.adminPosts).toHaveBeenCalledWith(
      { authorId: AUTHOR, text: 'needle', deleted: 'true' },
      cursor,
      5,
    );
  });

  it('rejects a malformed cursor (400, not a silent restart)', async () => {
    const { service } = makeService();
    await expect(service.adminListPosts({ cursor: '!!!not-base64!!!', limit: 20 })).rejects.toMatchObject(
      { status: 400 },
    );
  });

  it('shows a tombstoned post (users get 404 on the same id)', async () => {
    const { repo, service } = makeService();
    const tombstone = row({ deletedAt: new Date('2026-08-18T00:00:00Z') });
    repo.findPost.mockResolvedValue(tombstone);
    const post = await service.adminGetPost(tombstone.id);
    expect(post.deletedAt).toBe('2026-08-18T00:00:00.000Z');
  });

  it('soft-deletes as moderation, audits who/when, and emits the user-facing deleted event', async () => {
    const { repo, audits, events, service } = makeService();
    const target = row();
    repo.findPost.mockResolvedValue(target);

    await service.adminRemovePost(ADMIN, target.id, false);

    expect(repo.adminSoftDelete).toHaveBeenCalledWith(
      target.id,
      expect.objectContaining({ action: 'post.soft-delete', actorName: 'localadmin' }),
    );
    expect(audits).toHaveLength(1);
    expect(events.calls[0]![0]).toBe('posts.post.deleted');
    expect(events.calls[0]![1]).toMatchObject({ postId: target.id, authorId: AUTHOR });
  });

  it('hard-deletes with its own audit action and the same feed-removal event', async () => {
    const { audits, events, service } = makeService();
    const target = row();
    await service.adminRemovePost(ADMIN, target.id, true);
    expect(audits[0]!.action).toBe('post.hard-delete');
    expect(audits[0]!.detail).toEqual({ hard: true });
    expect(events.calls[0]![0]).toBe('posts.post.deleted');
  });

  it('404s when moderating a post that does not exist, with no event', async () => {
    const { repo, events, service } = makeService();
    repo.adminSoftDelete.mockResolvedValueOnce(null);
    await expect(service.adminRemovePost(ADMIN, 'missing', false)).rejects.toMatchObject({
      status: 404,
    });
    expect(events.calls).toHaveLength(0);
  });

  it('restores a soft-deleted post and re-emits created with the ORIGINAL creation time', async () => {
    const { repo, events, service } = makeService();
    const deleted = row({ deletedAt: new Date() });
    repo.adminRestore.mockResolvedValue(row({ id: deleted.id, deletedAt: null }));

    const restored = await service.adminRestorePost(ADMIN, deleted.id);

    expect(restored.deletedAt).toBeNull();
    expect(repo.adminRestore).toHaveBeenCalledWith(
      deleted.id,
      expect.objectContaining({ action: 'post.restore' }),
    );
    // Feeds re-materialise at the post's original chronological position.
    expect(events.calls[0]).toEqual([
      'posts.post.created',
      expect.objectContaining({ postId: deleted.id, createdAt: '2026-08-17T00:00:00.000Z' }),
    ]);
  });

  it('404s when restoring a post that is not deleted', async () => {
    const { repo, service } = makeService();
    repo.adminRestore.mockResolvedValue(null);
    await expect(service.adminRestorePost(ADMIN, 'live-post')).rejects.toMatchObject({ status: 404 });
  });
  it('derives the audit actor from the request principal (machine admins included)', async () => {
    const { repo, service } = makeService();
    const user = { subject: 'svc-admin-sa', username: 'svc-admin' } as RequestUser;
    await service.adminRemovePost({ actorId: user.subject, actorName: user.username }, 'p1', false);
    expect(repo.adminSoftDelete).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({ actorId: 'svc-admin-sa', actorName: 'svc-admin' }),
    );
  });
});
