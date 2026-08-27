import { describe, expect, it, vi } from 'vitest';
import type { FeedEntryInput, HydratedFeedItem, Post, Profile } from '@xitter/api-contracts';
import { FeedService, FEED_PAGE_MAX } from './feed.service.js';
import type { ContentHydrator } from './content-hydrator.js';
import type { FeedRealtime } from './feed-realtime.js';
import type { FeedEntryRow, FeedRepository } from './feed.repository.js';

const OWNER = '00000000-0000-4000-8000-000000000001';
const FOLLOWEE = '00000000-0000-4000-8000-000000000002';
const BLOCKED = '00000000-0000-4000-8000-000000000003';

const entry = (overrides: Partial<FeedEntryRow> = {}): FeedEntryRow => {
  const merged: FeedEntryRow = {
    id: overrides.id ?? crypto.randomUUID(),
    userId: OWNER,
    postId: overrides.postId ?? crypto.randomUUID(),
    authorId: overrides.authorId ?? FOLLOWEE,
    reason: 'post',
    repostedById: null,
    postCreatedAt: overrides.postCreatedAt ?? new Date(),
    insertedAt: new Date(),
    ...overrides,
    entryKey: '',
  };
  merged.entryKey =
    merged.reason === 'repost' && merged.repostedById
      ? `repost:${merged.postId}:${merged.repostedById}`
      : `post:${merged.postId}`;
  return merged;
};

const post = (id: string, authorId: string, createdAt: Date): Post => ({
  id,
  authorId,
  text: `post ${id}`,
  media: [],
  replyToId: null,
  repostOfId: null,
  counts: { replies: 0, likes: 0, reposts: 0 },
  createdAt: createdAt.toISOString(),
  deletedAt: null,
});

const profile = (id: string): Profile => ({
  id,
  username: 'user',
  displayName: 'User',
  bio: null,
  createdAt: new Date(0).toISOString(),
});

/**
 * In-memory FeedRepository with the same keyset semantics as the Prisma one
 * (newest first on (postCreatedAt, id); blocked authors excluded in query).
 */
function fakeRepo() {
  const rows = new Map<string, FeedEntryRow>();
  let inserted = 0;

  const page = (
    userId: string,
    cursor: string | undefined,
    limit: number,
    excludeAuthorIds: string[],
  ) => {
    let items = [...rows.values()]
      .filter((r) => r.userId === userId && !excludeAuthorIds.includes(r.authorId))
      .sort(
        (a, b) => b.postCreatedAt.getTime() - a.postCreatedAt.getTime() || (a.id < b.id ? 1 : -1),
      );
    if (cursor) {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        createdAt: string;
        id: string;
      };
      const boundary = new Date(decoded.createdAt).getTime();
      items = items.filter(
        (r) =>
          r.postCreatedAt.getTime() < boundary ||
          (r.postCreatedAt.getTime() === boundary && r.id < decoded.id),
      );
    }
    const pageRows = items.slice(0, limit);
    const hasMore = items.length > limit;
    const last = pageRows.at(-1);
    return Promise.resolve({
      items: pageRows,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ createdAt: last.postCreatedAt.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    });
  };

  const repo = {
    page,
    upsertEntries: (entries: FeedEntryRow[]) => {
      // Same natural key as the migration: (userId, entryKey).
      const existing = new Set([...rows.values()].map((e) => `${e.userId}|${e.entryKey}`));
      const fresh = entries.filter((e) => !existing.has(`${e.userId}|${e.entryKey}`));
      for (const e of fresh) {
        rows.set(`${e.userId}|${e.entryKey}`, e);
        inserted++;
      }
      return Promise.resolve(fresh.length);
    },
    deleteRepostEntries: (postId: string, repostedById: string) => {
      const before = rows.size;
      for (const [key, r] of rows)
        if (r.postId === postId && r.reason === 'repost' && r.repostedById === repostedById)
          rows.delete(key);
      return Promise.resolve(before - rows.size);
    },
    deleteByPost: (postId: string) => {
      const before = rows.size;
      for (const [key, r] of rows) if (r.postId === postId) rows.delete(key);
      return Promise.resolve(before - rows.size);
    },
    deleteByUserAndAuthor: (userId: string, authorId: string) => {
      const before = rows.size;
      for (const [key, r] of rows)
        if (r.userId === userId && r.authorId === authorId) rows.delete(key);
      return Promise.resolve(before - rows.size);
    },
    deleteByUser: (userId: string) => {
      const before = rows.size;
      for (const [key, r] of rows) if (r.userId === userId) rows.delete(key);
      return Promise.resolve(before - rows.size);
    },
    truncate: () => {
      rows.clear();
      return Promise.resolve(0);
    },
    toNewEntry: (input: FeedEntryInput) => {
      const reason = input.reason;
      const repostedById = input.repostedById ?? null;
      return {
        userId: input.userId,
        postId: input.postId,
        authorId: input.authorId,
        reason,
        repostedById,
        entryKey:
          reason === 'repost' && repostedById
            ? `repost:${input.postId}:${repostedById}`
            : `post:${input.postId}`,
        postCreatedAt: new Date(input.postCreatedAt),
      } as FeedEntryRow;
    },
    // exposed for assertions
    all: () => [...rows.values()],
    insertedCount: () => inserted,
  } as unknown as FeedRepository & {
    all(): FeedEntryRow[];
    insertedCount(): number;
  };
  return { repo, rows };
}

function fakeHydrator(
  overrides: Partial<ContentHydrator> = {},
): ContentHydrator & { store: { posts: Map<string, Post>; profiles: Map<string, Profile> } } {
  const posts = new Map<string, Post>();
  const profiles = new Map<string, Profile>();
  const byId =
    <T>(store: Map<string, T>) =>
    (ids: string[]) =>
      Promise.resolve(new Map(ids.filter((id) => store.has(id)).map((id) => [id, store.get(id)!])));
  return {
    posts: byId(posts),
    profiles: byId(profiles),
    blockedAuthorIds: () => Promise.resolve([]),
    ...overrides,
    store: { posts, profiles },
  };
}

function spyRealtime(): FeedRealtime & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    notify: (userIds) => {
      calls.push(userIds);
      return Promise.resolve();
    },
  };
}

describe('FeedService.getFeed', () => {
  it('returns entries newest-first with hydrated post + author', async () => {
    const { repo } = fakeRepo();
    const hydrator = fakeHydrator();
    const older = entry({
      postCreatedAt: new Date('2026-08-16T10:00:00Z'),
      postId: '00000000-0000-4000-8000-000000000011',
      authorId: FOLLOWEE,
    });
    const newer = entry({
      postCreatedAt: new Date('2026-08-17T10:00:00Z'),
      postId: '00000000-0000-4000-8000-000000000012',
      authorId: OWNER,
    });
    await repo.upsertEntries([older, newer]);
    hydrator.store.posts.set(older.postId, post(older.postId, FOLLOWEE, older.postCreatedAt));
    hydrator.store.posts.set(newer.postId, post(newer.postId, OWNER, newer.postCreatedAt));
    hydrator.store.profiles.set(FOLLOWEE, profile(FOLLOWEE));
    hydrator.store.profiles.set(OWNER, profile(OWNER));

    const service = new FeedService(repo, hydrator, spyRealtime());
    const page = await service.getFeed(OWNER, { limit: 20 });

    expect(page.items.map((item) => item.post.id)).toEqual([newer.postId, older.postId]);
    expect(page.items[0]!.author.id).toBe(OWNER);
    expect(page.items[1]!.author.id).toBe(FOLLOWEE);
    expect(page.nextCursor).toBeNull();
  });

  it('excludes blocked authors from the query', async () => {
    const { repo } = fakeRepo();
    const hydrator = fakeHydrator({
      blockedAuthorIds: (userId) => Promise.resolve(userId === OWNER ? [BLOCKED] : []),
    });
    const blockedEntry = entry({
      authorId: BLOCKED,
      postId: '00000000-0000-4000-8000-000000000021',
    });
    const fineEntry = entry({ authorId: FOLLOWEE, postId: '00000000-0000-4000-8000-000000000022' });
    await repo.upsertEntries([blockedEntry, fineEntry]);
    for (const e of [blockedEntry, fineEntry]) {
      hydrator.store.posts.set(e.postId, post(e.postId, e.authorId, e.postCreatedAt));
      hydrator.store.profiles.set(e.authorId, profile(e.authorId));
    }

    const service = new FeedService(repo, hydrator, spyRealtime());
    const page = await service.getFeed(OWNER, { limit: 20 });

    expect(page.items.map((item) => item.post.id)).toEqual([fineEntry.postId]);
  });

  it('drops deleted posts and refills the page from older entries', async () => {
    const { repo } = fakeRepo();
    const hydrator = fakeHydrator();
    const at = (h: number) => new Date(`2026-08-17T${String(10 + h).padStart(2, '0')}:00:00Z`);
    const entries = [0, 1, 2].map((h) =>
      entry({ postCreatedAt: at(h), postId: `00000000-0000-4000-8000-00000000003${h}` }),
    );
    await repo.upsertEntries(entries);
    // newest post (entries[2]) deleted: absent from the posts lookup
    hydrator.store.posts.set(
      entries[0]!.postId,
      post(entries[0]!.postId, FOLLOWEE, entries[0]!.postCreatedAt),
    );
    hydrator.store.posts.set(
      entries[1]!.postId,
      post(entries[1]!.postId, FOLLOWEE, entries[1]!.postCreatedAt),
    );
    hydrator.store.profiles.set(FOLLOWEE, profile(FOLLOWEE));

    const service = new FeedService(repo, hydrator, spyRealtime());
    const page = await service.getFeed(OWNER, { limit: 2 });

    // The deleted newest entry is skipped and the page still fills.
    expect(page.items.map((item) => item.post.id)).toEqual([
      entries[1]!.postId,
      entries[0]!.postId,
    ]);
  });

  it('paginates by cursor without repeating or skipping entries', async () => {
    const { repo } = fakeRepo();
    const hydrator = fakeHydrator();
    const at = (h: number) => new Date(`2026-08-17T0${h}:00:00Z`);
    const entries = [1, 2, 3].map((h) =>
      entry({ postCreatedAt: at(h), postId: `00000000-0000-4000-8000-00000000004${h}` }),
    );
    await repo.upsertEntries(entries);
    for (const e of entries) {
      hydrator.store.posts.set(e.postId, post(e.postId, FOLLOWEE, e.postCreatedAt));
      hydrator.store.profiles.set(e.authorId, profile(e.authorId));
    }

    const service = new FeedService(repo, hydrator, spyRealtime());
    const first = await service.getFeed(OWNER, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTypeOf('string');

    // 3 entries, 2 per page: the second page is the single oldest entry.
    const second = await service.getFeed(OWNER, { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((i) => i.post.id)).toEqual([entries[0]!.postId]);
    expect(second.nextCursor).toBeNull();
  });

  it('caps the page size at the contract maximum', async () => {
    const { repo } = fakeRepo();
    const hydrator = fakeHydrator();
    const spyPage = vi.spyOn(repo, 'page');
    const service = new FeedService(repo, hydrator, spyRealtime());

    await service.getFeed(OWNER, { limit: 500 });

    expect(spyPage).toHaveBeenCalledWith(OWNER, undefined, FEED_PAGE_MAX, []);
  });

  it('rejects malformed cursors with 400 instead of restarting the page', async () => {
    const { repo } = fakeRepo();
    const service = new FeedService(repo, fakeHydrator(), spyRealtime());

    await expect(
      service.getFeed(OWNER, { limit: 20, cursor: 'not-a-cursor' }),
    ).rejects.toMatchObject({
      response: { error: { code: 'VALIDATION_ERROR' } },
    });
  });

  it('renders a schema-valid placeholder when the author has no profile', async () => {
    const { repo } = fakeRepo();
    const hydrator = fakeHydrator();
    const e = entry({ postId: '00000000-0000-4000-8000-000000000051' });
    await repo.upsertEntries([e]);
    hydrator.store.posts.set(e.postId, post(e.postId, FOLLOWEE, e.postCreatedAt));

    const service = new FeedService(repo, hydrator, spyRealtime());
    const page = await service.getFeed(OWNER, { limit: 20 });

    const item: HydratedFeedItem = page.items[0]!;
    expect(item.author).toMatchObject({
      id: FOLLOWEE,
      username: 'unknown',
      displayName: 'Unknown',
    });
    expect(typeof item.author.createdAt).toBe('string');
  });

  it('renders repost entries with the ORIGINAL author and reposter attribution', async () => {
    const { repo } = fakeRepo();
    const hydrator = fakeHydrator();
    const at = new Date('2026-08-18T12:00:00Z');
    const repost = entry({
      postId: '00000000-0000-4000-8000-000000000052',
      authorId: FOLLOWEE, // reposter is the feed-surface author (entries.ts)
      reason: 'repost',
      repostedById: FOLLOWEE,
      postCreatedAt: at,
    });
    await repo.upsertEntries([repost]);
    // The ORIGINAL author differs from the surface author.
    hydrator.store.posts.set(repost.postId, post(repost.postId, BLOCKED, at));
    hydrator.store.profiles.set(FOLLOWEE, profile(FOLLOWEE));
    hydrator.store.profiles.set(BLOCKED, profile(BLOCKED));

    const service = new FeedService(repo, hydrator, spyRealtime());
    const page = await service.getFeed(OWNER, { limit: 20 });

    const item = page.items[0]!;
    expect(item.reason).toBe('repost');
    expect(item.repostedBy?.id).toBe(FOLLOWEE);
    // The card identity is the post's OWN author (#145) - the reposter must
    // never render as the author of someone else's post. The real profile
    // (not a placeholder) proves the original author joined the batch.
    expect(item.author.id).toBe(BLOCKED);
    expect(item.author.username).toBe('user');
    expect(item.post.authorId).toBe(BLOCKED);
  });

  it("renders a repost of the viewer's own post as the viewer's (#145 incident regression)", async () => {
    // Live incident 2026-08-27: a repost of the viewer's post showed the
    // REPOSTER as the card author while the web gated delete on
    // post.authorId - the owner deleted their own post believing it was
    // someone else's. Identity and permission must pair.
    const { repo } = fakeRepo();
    const hydrator = fakeHydrator();
    const at = new Date('2026-08-18T12:00:00Z');
    const repost = entry({
      postId: '00000000-0000-4000-8000-000000000054',
      authorId: FOLLOWEE, // surface author = reposter
      reason: 'repost',
      repostedById: FOLLOWEE,
      postCreatedAt: at,
    });
    await repo.upsertEntries([repost]);
    hydrator.store.posts.set(repost.postId, post(repost.postId, OWNER, at)); // OWNER's own post
    hydrator.store.profiles.set(FOLLOWEE, profile(FOLLOWEE));
    hydrator.store.profiles.set(OWNER, profile(OWNER));

    const service = new FeedService(repo, hydrator, spyRealtime());
    const page = await service.getFeed(OWNER, { limit: 20 });

    const item = page.items[0]!;
    // The byline is the true author, so the web's delete gate
    // (post.authorId === viewerId) agrees with the rendered identity.
    expect(item.author.id).toBe(OWNER);
    expect(item.post.authorId).toBe(OWNER);
    expect(item.repostedBy?.id).toBe(FOLLOWEE);
  });

  it('drops reposts whose ORIGINAL author the viewer blocked (hydration filter)', async () => {
    const { repo } = fakeRepo();
    const hydrator = fakeHydrator({
      blockedAuthorIds: (userId) => Promise.resolve(userId === OWNER ? [BLOCKED] : []),
    });
    const at = new Date('2026-08-18T12:00:00Z');
    const repost = entry({
      postId: '00000000-0000-4000-8000-000000000053',
      authorId: FOLLOWEE,
      reason: 'repost',
      repostedById: FOLLOWEE,
      postCreatedAt: at,
    });
    await repo.upsertEntries([repost]);
    hydrator.store.posts.set(repost.postId, post(repost.postId, BLOCKED, at)); // original author blocked

    const service = new FeedService(repo, hydrator, spyRealtime());
    const page = await service.getFeed(OWNER, { limit: 20 });

    expect(page.items).toHaveLength(0);
  });
});

describe('FeedService.upsertEntries', () => {
  it('inserts entries and notifies affected users once each', async () => {
    const { repo } = fakeRepo();
    const realtime = spyRealtime();
    const service = new FeedService(repo, fakeHydrator(), realtime);

    const input = (userId: string): FeedEntryInput => ({
      userId,
      postId: '00000000-0000-4000-8000-000000000061',
      authorId: FOLLOWEE,
      reason: 'post',
      repostedById: null,
      postCreatedAt: '2026-08-18T09:00:00.000Z',
    });

    const result = await service.upsertEntries([input(OWNER), input(FOLLOWEE)]);
    expect(result).toEqual({ inserted: 2 });
    expect(realtime.calls).toEqual([[OWNER, FOLLOWEE]]);
    expect(repo.insertedCount()).toBe(2);
  });

  it('keeps entry derivation idempotent on the natural key', async () => {
    const { repo } = fakeRepo();
    const service = new FeedService(repo, fakeHydrator(), spyRealtime());
    const input: FeedEntryInput = {
      userId: OWNER,
      postId: '00000000-0000-4000-8000-000000000071',
      authorId: FOLLOWEE,
      reason: 'post',
      repostedById: null,
      postCreatedAt: '2026-08-18T09:00:00.000Z',
    };

    await service.upsertEntries([input]);
    const second = await service.upsertEntries([input]); // event replay

    // Nothing new inserted - the natural key absorbs the redelivery.
    expect(second).toEqual({ inserted: 0 });
    expect(repo.all()).toHaveLength(1);
  });

  it('keeps two different reposters of the same post distinct (#8 key)', async () => {
    const { repo } = fakeRepo();
    const service = new FeedService(repo, fakeHydrator(), spyRealtime());
    const postId = '00000000-0000-4000-8000-000000000072';
    const repost = (reposter: string): FeedEntryInput => ({
      userId: OWNER,
      postId,
      authorId: reposter,
      reason: 'repost',
      repostedById: reposter,
      postCreatedAt: '2026-08-18T09:00:00.000Z',
    });

    await service.upsertEntries([repost(FOLLOWEE)]);
    const second = await service.upsertEntries([repost(BLOCKED)]);

    // The second reposter's entry lands too - (userId, postId, reason) would
    // have collided and silently dropped it.
    expect(second).toEqual({ inserted: 1 });
    expect(repo.all()).toHaveLength(2);
  });

  it('replays the same repost idempotently', async () => {
    const { repo } = fakeRepo();
    const service = new FeedService(repo, fakeHydrator(), spyRealtime());
    const input: FeedEntryInput = {
      userId: OWNER,
      postId: '00000000-0000-4000-8000-000000000073',
      authorId: FOLLOWEE,
      reason: 'repost',
      repostedById: FOLLOWEE,
      postCreatedAt: '2026-08-18T09:00:00.000Z',
    };

    await service.upsertEntries([input]);
    const replay = await service.upsertEntries([input]);

    expect(replay).toEqual({ inserted: 0 });
    expect(repo.all()).toHaveLength(1);
  });
});

describe('FeedService deletes', () => {
  it('removes a deleted post from every feed', async () => {
    const { repo } = fakeRepo();
    const e = entry({ postId: '00000000-0000-4000-8000-000000000081', userId: OWNER });
    await repo.upsertEntries([
      e,
      entry({ postId: '00000000-0000-4000-8000-000000000081', userId: FOLLOWEE }),
    ]);

    const service = new FeedService(repo, fakeHydrator(), spyRealtime());
    await expect(
      service.deletePostEntries('00000000-0000-4000-8000-000000000081'),
    ).resolves.toEqual({ deleted: 2 });
    expect(repo.all()).toHaveLength(0);
  });

  it('removes only the undone reposter repost entries (post entries stay)', async () => {
    const { repo } = fakeRepo();
    const postId = '00000000-0000-4000-8000-000000000082';
    await repo.upsertEntries([
      // The post's own entry in OWNER's feed.
      entry({ userId: OWNER, postId, reason: 'post' }),
      // FOLLOWEE's repost visible to OWNER.
      entry({
        userId: OWNER,
        postId,
        reason: 'repost',
        repostedById: FOLLOWEE,
        authorId: FOLLOWEE,
      }),
      // A different reposter's repost - must survive.
      entry({ userId: OWNER, postId, reason: 'repost', repostedById: BLOCKED, authorId: BLOCKED }),
    ]);

    const service = new FeedService(repo, fakeHydrator(), spyRealtime());
    await expect(service.deleteRepostEntries(postId, FOLLOWEE)).resolves.toEqual({ deleted: 1 });
    expect(repo.all()).toHaveLength(2);
    expect(repo.all().some((r) => r.repostedById === FOLLOWEE)).toBe(false);
  });

  it('removes only the unfollowed author from the user feed', async () => {
    const { repo } = fakeRepo();
    await repo.upsertEntries([
      entry({ userId: OWNER, authorId: BLOCKED, postId: '00000000-0000-4000-8000-000000000091' }),
      entry({ userId: OWNER, authorId: FOLLOWEE, postId: '00000000-0000-4000-8000-000000000092' }),
      entry({
        userId: FOLLOWEE,
        authorId: BLOCKED,
        postId: '00000000-0000-4000-8000-000000000093',
      }),
    ]);

    const service = new FeedService(repo, fakeHydrator(), spyRealtime());
    await expect(service.deleteAuthorEntries(OWNER, BLOCKED)).resolves.toEqual({ deleted: 1 });
    expect(repo.all().map((r) => r.postId)).not.toContain('00000000-0000-4000-8000-000000000091');
    expect(repo.all()).toHaveLength(2);
  });

  it('resets a whole user feed', async () => {
    const { repo } = fakeRepo();
    await repo.upsertEntries([
      entry({ userId: OWNER, postId: '00000000-0000-4000-8000-0000000000a1' }),
      entry({ userId: FOLLOWEE, postId: '00000000-0000-4000-8000-0000000000a2' }),
    ]);

    const service = new FeedService(repo, fakeHydrator(), spyRealtime());
    await expect(service.resetUser(OWNER)).resolves.toEqual({ deleted: 1 });
    expect(repo.all()).toHaveLength(1);
  });
});
