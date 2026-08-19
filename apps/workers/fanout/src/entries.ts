import type { FeedEntryInput, PostCreated, FollowCreated } from '@xitter/api-contracts';

/** Follow backfill window: most recent N posts of the followee (spec 04). */
export const BACKFILL_POSTS = 20;

/**
 * Feed-entry derivation, pure and replay-safe (spec 04 idempotency: entries
 * land on the natural key, so re-deriving an event is a no-op).
 */
export function entriesForNewPost(
  event: Pick<PostCreated, 'postId' | 'authorId' | 'createdAt'>,
  followerIds: readonly string[],
): FeedEntryInput[] {
  // Author + followers: own posts belong in the author's feed too.
  const recipients = new Set<string>([event.authorId, ...followerIds]);
  return [...recipients].map((userId) => ({
    userId,
    postId: event.postId,
    authorId: event.authorId,
    reason: 'post' as const,
    repostedById: null,
    postCreatedAt: event.createdAt,
  }));
}

/**
 * Backfill entries for a new follow: the followee's recent posts land in
 * the follower's feed, capped at BACKFILL_POSTS (ADR 0003: recent history
 * only - full rebuilds are a reset concern, not a runtime one).
 */
export function entriesForBackfill(
  event: Pick<FollowCreated, 'followerId' | 'followeeId'>,
  posts: readonly Pick<PostCreated, 'postId' | 'authorId' | 'createdAt'>[],
): FeedEntryInput[] {
  return posts.slice(0, BACKFILL_POSTS).map((post) => ({
    userId: event.followerId,
    postId: post.postId,
    authorId: post.authorId,
    reason: 'post' as const,
    repostedById: null,
    postCreatedAt: post.createdAt,
  }));
}
