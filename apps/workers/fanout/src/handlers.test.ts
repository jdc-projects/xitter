import { describe, expect, it, vi } from 'vitest';
import type { FeedEntryInput, Post } from '@xitter/api-contracts';
import { EVENT_TYPES } from '@xitter/events';
import {
  BACKFILL_POSTS,
  entriesForBackfill,
  entriesForNewPost,
  entriesForRepost,
} from './entries.js';
import { handleEvent, type FeedApi, type PostsApi, type SocialApi } from './handlers.js';

const AUTHOR = '00000000-0000-4000-8000-0000000000a1';
const FOLLOWER_1 = '00000000-0000-4000-8000-0000000000b1';
const FOLLOWER_2 = '00000000-0000-4000-8000-0000000000b2';

const CREATED_AT = '2026-08-18T09:00:00.000Z';

describe('entriesForNewPost', () => {
  it('derives one entry per follower plus the author', () => {
    const entries = entriesForNewPost(
      { postId: '00000000-0000-4000-8000-0000000000c1', authorId: AUTHOR, createdAt: CREATED_AT },
      [FOLLOWER_1, FOLLOWER_2],
    );

    expect(entries.map((e) => e.userId).sort()).toEqual([AUTHOR, FOLLOWER_1, FOLLOWER_2].sort());
    for (const entry of entries) {
      expect(entry).toMatchObject({
        postId: '00000000-0000-4000-8000-0000000000c1',
        authorId: AUTHOR,
        reason: 'post',
        repostedById: null,
        postCreatedAt: CREATED_AT,
      });
    }
  });

  it('de-duplicates when the author appears among their own followers', () => {
    const entries = entriesForNewPost(
      { postId: '00000000-0000-4000-8000-0000000000c2', authorId: AUTHOR, createdAt: CREATED_AT },
      [AUTHOR, FOLLOWER_1],
    );
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.userId)).size).toBe(2);
  });

  it('carries the post time as the feed ordering key', () => {
    const [entry] = entriesForNewPost(
      { postId: '00000000-0000-4000-8000-0000000000c3', authorId: AUTHOR, createdAt: CREATED_AT },
      [],
    );
    expect(entry!.postCreatedAt).toBe(CREATED_AT); // not insertedAt, not event time
  });
});

describe('entriesForRepost', () => {
  const postId = '00000000-0000-4000-8000-0000000000c4';
  const event = { postId, userId: FOLLOWER_1, createdAt: CREATED_AT };

  it('derives repost entries for the reposter + their followers, attributed', () => {
    const entries = entriesForRepost(event, [FOLLOWER_2, AUTHOR]);

    expect(entries.map((e) => e.userId).sort()).toEqual([FOLLOWER_1, FOLLOWER_2, AUTHOR].sort());
    for (const entry of entries) {
      expect(entry).toMatchObject({
        postId,
        authorId: FOLLOWER_1, // reposter is the feed-surface author
        reason: 'repost',
        repostedById: FOLLOWER_1,
        postCreatedAt: CREATED_AT, // repost time orders the feed item
      });
    }
  });

  it('de-duplicates when the reposter appears among their own followers', () => {
    const entries = entriesForRepost(event, [FOLLOWER_1]);
    expect(entries).toHaveLength(1);
  });
});

describe('entriesForBackfill', () => {
  const follow = { followerId: FOLLOWER_1, followeeId: AUTHOR };

  it('backfills the followee posts into the follower feed only', () => {
    const entries = entriesForBackfill(follow, [
      { postId: '00000000-0000-4000-8000-0000000000d1', authorId: AUTHOR, createdAt: CREATED_AT },
      { postId: '00000000-0000-4000-8000-0000000000d2', authorId: AUTHOR, createdAt: CREATED_AT },
    ]);

    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.userId))).toEqual(new Set([FOLLOWER_1]));
    expect(entries.every((e) => e.authorId === AUTHOR)).toBe(true);
  });

  it(`caps the window at ${BACKFILL_POSTS} posts`, () => {
    const posts = Array.from({ length: BACKFILL_POSTS + 10 }, (_, i) => ({
      postId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      authorId: AUTHOR,
      createdAt: CREATED_AT,
    }));
    expect(entriesForBackfill(follow, posts)).toHaveLength(BACKFILL_POSTS);
  });
});

function fakeDeps() {
  const upserts: FeedEntryInput[][] = [];
  const deletedPosts: string[] = [];
  const removedAuthors: { userId: string; authorId: string }[] = [];
  const removedReposts: { postId: string; repostedById: string }[] = [];
  const deps = {
    social: {
      internalFollowerIds: vi.fn(() => Promise.resolve([FOLLOWER_1, FOLLOWER_2])),
    } as unknown as SocialApi,
    posts: {
      internalGetAuthorPosts: vi.fn(() => Promise.resolve({ items: [], nextCursor: null })),
    } as unknown as PostsApi,
    feed: {
      internalUpsertEntries: vi.fn((entries: FeedEntryInput[]) => {
        upserts.push(entries);
        return Promise.resolve({ inserted: entries.length });
      }),
      internalDeletePostEntries: vi.fn((postId: string) => {
        deletedPosts.push(postId);
        return Promise.resolve({ deleted: 1 });
      }),
      internalDeleteAuthorEntries: vi.fn((userId: string, authorId: string) => {
        removedAuthors.push({ userId, authorId });
        return Promise.resolve({ deleted: 1 });
      }),
      internalDeleteRepostEntries: vi.fn((postId: string, repostedById: string) => {
        removedReposts.push({ postId, repostedById });
        return Promise.resolve({ deleted: 1 });
      }),
    } as unknown as FeedApi,
  };
  return { deps, upserts, deletedPosts, removedAuthors, removedReposts };
}

const postCreatedEnvelope = (payload: object) => ({
  eventId: crypto.randomUUID(),
  eventType: EVENT_TYPES.postCreated,
  eventVersion: 1,
  producer: 'posts',
  occurredAt: CREATED_AT,
  payload: {
    postId: '00000000-0000-4000-8000-0000000000e1',
    authorId: AUTHOR,
    text: 'hello',
    mediaIds: [],
    replyToId: null,
    repostOfId: null,
    createdAt: CREATED_AT,
    ...payload,
  },
});

describe('handleEvent dispatch', () => {
  it('fans post.created out to author + followers via the feed internal API', async () => {
    const { deps, upserts } = fakeDeps();

    await handleEvent(postCreatedEnvelope({}), deps);

    expect(deps.social.internalFollowerIds).toHaveBeenCalledWith(AUTHOR);
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.map((e) => e.userId).sort()).toEqual(
      [AUTHOR, FOLLOWER_1, FOLLOWER_2].sort(),
    );
  });

  it('backfills follow.created from the followee recent posts', async () => {
    const { deps, upserts } = fakeDeps();
    const items: Post[] = [1, 2].map((n) => ({
      id: `00000000-0000-4000-8000-0000000000f${n}`,
      authorId: AUTHOR,
      text: `post ${n}`,
      media: [],
      replyToId: null,
      repostOfId: null,
      counts: { replies: 0, likes: 0, reposts: 0 },
      createdAt: CREATED_AT,
      deletedAt: null,
    }));
    (deps.posts.internalGetAuthorPosts as ReturnType<typeof vi.fn>).mockResolvedValue({
      items,
      nextCursor: null,
    });

    await handleEvent(
      {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.followCreated,
        eventVersion: 1,
        producer: 'social',
        occurredAt: CREATED_AT,
        payload: { followerId: FOLLOWER_1, followeeId: AUTHOR, createdAt: CREATED_AT },
      },
      deps,
    );

    expect(deps.posts.internalGetAuthorPosts).toHaveBeenCalledWith(AUTHOR, undefined, 20);
    expect(upserts[0]).toHaveLength(2);
    expect(upserts[0]!.every((e) => e.userId === FOLLOWER_1)).toBe(true);
  });

  it('removes entries on post.deleted', async () => {
    const { deps, deletedPosts } = fakeDeps();

    await handleEvent(
      {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.postDeleted,
        eventVersion: 1,
        producer: 'posts',
        occurredAt: CREATED_AT,
        payload: {
          postId: '00000000-0000-4000-8000-0000000000e1',
          authorId: AUTHOR,
          deletedAt: CREATED_AT,
        },
      },
      deps,
    );

    expect(deletedPosts).toEqual(['00000000-0000-4000-8000-0000000000e1']);
  });

  it('removes the followee from the follower feed on follow.deleted', async () => {
    const { deps, removedAuthors } = fakeDeps();

    await handleEvent(
      {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.followDeleted,
        eventVersion: 1,
        producer: 'social',
        occurredAt: CREATED_AT,
        payload: { followerId: FOLLOWER_1, followeeId: AUTHOR, deletedAt: CREATED_AT },
      },
      deps,
    );

    expect(removedAuthors).toEqual([{ userId: FOLLOWER_1, authorId: AUTHOR }]);
  });

  it('fans interaction.created (repost) out to the reposter audience', async () => {
    const { deps, upserts } = fakeDeps();
    const postId = '00000000-0000-4000-8000-0000000000a1';

    await handleEvent(
      {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.interactionCreated,
        eventVersion: 1,
        producer: 'posts',
        occurredAt: CREATED_AT,
        payload: {
          interactionId: '00000000-0000-4000-8000-0000000000a2',
          kind: 'repost',
          postId,
          userId: FOLLOWER_1,
          createdAt: CREATED_AT,
        },
      },
      deps,
    );

    // Followers of the REPOSTER (not the original author) get the entry.
    expect(deps.social.internalFollowerIds).toHaveBeenCalledWith(FOLLOWER_1);
    const entries = upserts[0]!;
    expect(entries.map((e) => e.userId).sort()).toEqual([FOLLOWER_1, FOLLOWER_2].sort());
    expect(entries.every((e) => e.reason === 'repost' && e.repostedById === FOLLOWER_1)).toBe(true);
  });

  it('ignores like/bookmark interaction.created (no feed entries)', async () => {
    const { deps, upserts } = fakeDeps();

    for (const kind of ['like', 'bookmark'] as const) {
      await handleEvent(
        {
          eventId: crypto.randomUUID(),
          eventType: EVENT_TYPES.interactionCreated,
          eventVersion: 1,
          producer: 'posts',
          occurredAt: CREATED_AT,
          payload: {
            interactionId: '00000000-0000-4000-8000-0000000000b1',
            kind,
            postId: '00000000-0000-4000-8000-0000000000b2',
            userId: FOLLOWER_1,
            createdAt: CREATED_AT,
          },
        },
        deps,
      );
    }

    expect(upserts).toHaveLength(0);
    expect(deps.social.internalFollowerIds).not.toHaveBeenCalled();
  });

  it('removes repost entries on interaction.deleted (repost)', async () => {
    const { deps, removedReposts } = fakeDeps();

    await handleEvent(
      {
        eventId: crypto.randomUUID(),
        eventType: EVENT_TYPES.interactionDeleted,
        eventVersion: 1,
        producer: 'posts',
        occurredAt: CREATED_AT,
        payload: {
          kind: 'repost',
          postId: '00000000-0000-4000-8000-0000000000c1',
          userId: FOLLOWER_1,
          deletedAt: CREATED_AT,
        },
      },
      deps,
    );

    expect(removedReposts).toEqual([
      { postId: '00000000-0000-4000-8000-0000000000c1', repostedById: FOLLOWER_1 },
    ]);
  });

  it('ignores block events (history stays - product decision) and unknown types', async () => {
    const { deps, upserts } = fakeDeps();

    for (const eventType of [EVENT_TYPES.blockCreated, 'nothing.interesting']) {
      await handleEvent(
        {
          eventId: crypto.randomUUID(),
          eventType,
          eventVersion: 1,
          producer: 'social',
          occurredAt: CREATED_AT,
          payload: { blockerId: AUTHOR, blockedId: FOLLOWER_1, createdAt: CREATED_AT },
        },
        deps,
      );
    }

    expect(upserts).toHaveLength(0);
    expect(deps.feed.internalDeletePostEntries).not.toHaveBeenCalled();
  });

  it('skips payloads that fail the shared event schema', async () => {
    const { deps, upserts } = fakeDeps();

    // missing createdAt + bad authorId shape: must not reach the feed API
    await handleEvent(postCreatedEnvelope({ authorId: 'not-a-uuid', createdAt: undefined }), deps);

    expect(upserts).toHaveLength(0);
  });

  it('rethrows handler failures so Kafka redelivers', async () => {
    const { deps } = fakeDeps();
    (deps.feed.internalUpsertEntries as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('feed down'),
    );

    await expect(handleEvent(postCreatedEnvelope({}), deps)).rejects.toThrow('feed down');
  });
});
