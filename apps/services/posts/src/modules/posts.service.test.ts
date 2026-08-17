import { describe, expect, it, vi } from 'vitest';
import { createPostRequestSchema, POST_MEDIA_MAX, POST_TEXT_MAX } from '@xitter/api-contracts';
import { PostsService } from './posts.service.js';
import type { PostsEvents } from './posts-events.js';
import type { PostsRepository, PostRow } from './posts.repository.js';
import type { RelationshipChecker } from './relationship-checker.js';

const AUTHOR = '00000000-0000-4000-8000-000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';

const row = (overrides: Partial<PostRow> = {}): PostRow => ({
  id: '00000000-0000-4000-8000-000000000a01',
  authorId: AUTHOR,
  text: 'hello xitter',
  mediaIds: [],
  replyToId: null,
  repostOfId: null,
  createdAt: new Date('2026-08-17T00:00:00Z'),
  deletedAt: null,
  replyCount: 0,
  likeCount: 0,
  repostCount: 0,
  ...overrides,
});

function fakeRepo(overrides: Partial<PostsRepository> = {}) {
  const posts = new Map<string, PostRow>();
  const repo = {
    findPost: (id: string) => Promise.resolve(posts.get(id) ?? null),
    findVisiblePost: (id: string) => {
      const found = posts.get(id);
      return Promise.resolve(found && !found.deletedAt ? found : null);
    },
    createPost: (input: {
      authorId: string;
      text: string;
      mediaIds: string[];
      replyToId: string | null;
    }) => {
      const created = row({ id: crypto.randomUUID(), ...input });
      posts.set(created.id, created);
      return Promise.resolve(created);
    },
    softDelete: (id: string) => {
      const found = posts.get(id);
      if (!found || found.deletedAt) return Promise.resolve(null);
      const deleted = { ...found, deletedAt: new Date() };
      posts.set(id, deleted);
      return Promise.resolve(deleted);
    },
    authorPosts: () => Promise.resolve({ items: [...posts.values()], nextCursor: null }),
    replies: () => Promise.resolve({ items: [], nextCursor: null }),
    truncate: () => {
      posts.clear();
      return Promise.resolve();
    },
    toCounts: (r: PostRow) => ({ replies: r.replyCount, likes: r.likeCount, reposts: r.repostCount }),
    ...overrides,
  } as unknown as PostsRepository;
  return { repo, posts };
}

function spyEvents(): PostsEvents & { calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    emit: (eventType, payload) => {
      calls.push([eventType, payload]);
      return Promise.resolve();
    },
    shutdown: () => Promise.resolve(),
  };
}

const allowAll: RelationshipChecker = { blockedEitherWay: () => Promise.resolve(false) };

describe('createPostRequestSchema (contract)', () => {
  it('accepts a minimal text-only body and defaults mediaIds/replyToId', () => {
    expect(createPostRequestSchema.parse({ text: 'hi' })).toEqual({
      text: 'hi',
      mediaIds: [],
      replyToId: null,
    });
  });

  it(`rejects ${POST_TEXT_MAX + 1}-character text`, () => {
    expect(
      createPostRequestSchema.safeParse({ text: 'x'.repeat(POST_TEXT_MAX + 1) }).success,
    ).toBe(false);
  });

  it('rejects empty text', () => {
    expect(createPostRequestSchema.safeParse({ text: '' }).success).toBe(false);
  });

  it(`rejects more than ${POST_MEDIA_MAX} media ids and non-uuid shapes`, () => {
    const uuid = '00000000-0000-4000-8000-00000000000m';
    expect(
      createPostRequestSchema.safeParse({ text: 'x', mediaIds: Array(POST_MEDIA_MAX + 1).fill(uuid) })
        .success,
    ).toBe(false);
    expect(
      createPostRequestSchema.safeParse({ text: 'x', mediaIds: ['not-a-uuid'] }).success,
    ).toBe(false);
  });

  it('is strict: unknown keys are rejected, not stripped', () => {
    expect(createPostRequestSchema.safeParse({ text: 'x', username: 'hijack' }).success).toBe(false);
  });
});

describe('PostsService rules', () => {
  it('creates a post with zero-initialised counts and emits the full payload', async () => {
    const { repo } = fakeRepo();
    const events = spyEvents();
    const service = new PostsService(repo, events, allowAll);

    const post = await service.create(AUTHOR, {
      text: 'first post',
      mediaIds: [],
      replyToId: null,
    });

    expect(post.counts).toEqual({ replies: 0, likes: 0, reposts: 0 });
    expect(post.deletedAt).toBeNull();
    expect(events.calls).toHaveLength(1);
    const [type, payload] = events.calls[0]!;
    expect(type).toBe('posts.post.created');
    expect(payload).toMatchObject({
      postId: post.id,
      authorId: AUTHOR,
      text: 'first post',
      mediaIds: [],
      replyToId: null,
      repostOfId: null,
    });
  });

  it('emits mediaIds and replyToId through the created event', async () => {
    const { repo, posts } = fakeRepo();
    const events = spyEvents();
    const parent = row({ id: '00000000-0000-4000-8000-000000000a11' });
    posts.set(parent.id, parent);
    const service = new PostsService(repo, events, allowAll);

    await service.create(OTHER, {
      text: 'a reply',
      mediaIds: ['00000000-0000-4000-8000-0000000003d1'],
      replyToId: parent.id,
    });

    expect(events.calls[0]?.[1]).toMatchObject({
      replyToId: parent.id,
      mediaIds: ['00000000-0000-4000-8000-0000000003d1'],
    });
  });

  it('rejects replies to missing or deleted parents', async () => {
    const { repo, posts } = fakeRepo();
    const service = new PostsService(repo, spyEvents(), allowAll);

    await expect(service.create(AUTHOR, { text: 'x', mediaIds: [], replyToId: OTHER })).rejects.toMatchObject(
      { response: { error: { code: 'NOT_FOUND' } } },
    );

    const deleted = row({ id: '00000000-0000-4000-8000-000000000a12', deletedAt: new Date() });
    posts.set(deleted.id, deleted);
    await expect(
      service.create(AUTHOR, { text: 'x', mediaIds: [], replyToId: deleted.id }),
    ).rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });
  });

  it('rejects replies when blocked in either direction, without checking on self-replies', async () => {
    const { repo } = fakeRepo();
    const parent = row({ id: '00000000-0000-4000-8000-000000000a13' });
    (repo.findVisiblePost as (id: string) => Promise<PostRow | null>) = (id) =>
      Promise.resolve(id === parent.id ? parent : null);

    const calls: [string, string][] = [];
    const blockedChecker: RelationshipChecker = {
      blockedEitherWay: (viewerId, otherId) => {
        calls.push([viewerId, otherId]);
        return Promise.resolve(true);
      },
    };
    const service = new PostsService(repo, spyEvents(), blockedChecker);

    await expect(
      service.create(OTHER, { text: 'reply', mediaIds: [], replyToId: parent.id }),
    ).rejects.toMatchObject({ response: { error: { code: 'FORBIDDEN' } } });
    // social is asked about (replier, author) - the pair the block lives on.
    expect(calls).toEqual([[OTHER, AUTHOR]]);

    // Self-replies skip the social call entirely (no block can exist).
    await expect(
      service.create(AUTHOR, { text: 'self thread', mediaIds: [], replyToId: parent.id }),
    ).resolves.toMatchObject({ replyToId: parent.id });
    expect(calls).toHaveLength(1);
  });

  it('soft-deletes own posts, hides them from reads, and emits once', async () => {
    const { repo } = fakeRepo();
    const events = spyEvents();
    const service = new PostsService(repo, events, allowAll);
    const post = await service.create(AUTHOR, { text: 'gone soon', mediaIds: [], replyToId: null });

    await service.remove(AUTHOR, post.id);
    // Deleted reads as missing: a repeat delete 404s like any absent post.
    await expect(service.remove(AUTHOR, post.id)).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });

    await expect(service.getPost(post.id)).rejects.toMatchObject({
      response: { error: { code: 'NOT_FOUND' } },
    });
    expect(events.calls.filter(([type]) => type === 'posts.post.deleted')).toHaveLength(1);
  });

  it('only the author may delete; others get 403 and missing ids 404', async () => {
    const { repo } = fakeRepo();
    const service = new PostsService(repo, spyEvents(), allowAll);
    const post = await service.create(AUTHOR, { text: 'mine', mediaIds: [], replyToId: null });

    await expect(service.remove(OTHER, post.id)).rejects.toMatchObject({
      response: { error: { code: 'FORBIDDEN' } },
    });
    await expect(
      service.remove(AUTHOR, '00000000-0000-4000-8000-000000000a15'),
    ).rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });
  });

  it('a failed event emission never fails the committed mutation', async () => {
    const { repo } = fakeRepo();
    const failing: PostsEvents = {
      emit: vi.fn().mockRejectedValue(new Error('kafka down')),
      shutdown: () => Promise.resolve(),
    };
    const service = new PostsService(repo, failing, allowAll);

    await expect(
      service.create(AUTHOR, { text: 'still works', mediaIds: [], replyToId: null }),
    ).resolves.toMatchObject({ text: 'still works' });
  });
});
