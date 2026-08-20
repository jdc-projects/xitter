import type {
  FeedEntryInput,
  InteractionCreated,
  PostCreated,
  FollowCreated,
} from '@xitter/api-contracts';

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
 * Repost entries (#8): a repost surfaces in the REPOSTER's followers' feeds
 * (and their own) attributed to the reposter - not the original author's
 * audience. `postCreatedAt` is the repost (interaction) time: reposts arrive
 * as fresh feed items wherever they land. `authorId` is the reposter (the
 * feed-surface author, so unfollow removes their reposts too).
 */
export function entriesForRepost(
  event: Pick<InteractionCreated, 'postId' | 'userId' | 'createdAt'>,
  followerIds: readonly string[],
): FeedEntryInput[] {
  const reposterId = event.userId;
  const recipients = new Set<string>([reposterId, ...followerIds]);
  return [...recipients].map((userId) => ({
    userId,
    postId: event.postId,
    authorId: reposterId,
    reason: 'repost' as const,
    repostedById: reposterId,
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
