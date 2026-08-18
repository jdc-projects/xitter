import type { FeedEntryInput, Post, PostCreated } from '@xitter/api-contracts';
import { eventSchemas, EVENT_TYPES, type DomainEvent } from '@xitter/events';
import { createLogger } from '@xitter/observability';
import { BACKFILL_POSTS, entriesForBackfill, entriesForNewPost } from './entries.js';

const logger = createLogger({ service: 'fanout-worker' });

/** What the worker needs from social (test seam). */
export interface SocialApi {
  internalFollowerIds(userId: string): Promise<string[]>;
}

/** What the worker needs from posts (test seam). */
export interface PostsApi {
  internalGetAuthorPosts(
    userId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: Post[]; nextCursor: string | null }>;
}

/** What the worker needs from feed (test seam). */
export interface FeedApi {
  internalUpsertEntries(entries: FeedEntryInput[]): Promise<{ inserted: number }>;
  internalDeletePostEntries(postId: string): Promise<{ deleted: number }>;
  internalDeleteAuthorEntries(userId: string, authorId: string): Promise<{ deleted: number }>;
}

export interface HandlerDeps {
  social: SocialApi;
  posts: PostsApi;
  feed: FeedApi;
}

/**
 * Fanout dispatch (spec 04 / ADR 0003):
 *
 * - `posts.post.created` → entries for the author's followers + the author;
 * - `social.follow.created` → backfill the followee's recent posts into the
 *   follower's feed;
 * - `posts.post.deleted` → the post leaves every feed;
 * - `social.follow.deleted` → the followee's entries leave the follower's feed;
 * - block events are not consumed (product decision: history stays).
 *
 * Payloads validate against the shared event schemas at this boundary;
 * everything downstream is idempotent on the feed natural key, so
 * at-least-once redelivery converges.
 */
export async function handleEvent(envelope: unknown, deps: HandlerDeps): Promise<void> {
  const { eventType, payload } = (envelope ?? {}) as {
    eventType?: string;
    payload?: Record<string, unknown>;
  };

  switch (eventType) {
    case EVENT_TYPES.postCreated: {
      const event = parseEvent(eventType, payload);
      if (!event || event.eventType !== EVENT_TYPES.postCreated) return;
      const followerIds = await deps.social.internalFollowerIds(event.authorId);
      await deps.feed.internalUpsertEntries(entriesForNewPost(event, followerIds));
      logger.info({ postId: event.postId, recipients: followerIds.length + 1 }, 'post fanned out');
      return;
    }
    case EVENT_TYPES.followCreated: {
      const event = parseEvent(eventType, payload);
      if (!event || event.eventType !== EVENT_TYPES.followCreated) return;
      const recent = await collectRecentPosts(deps.posts, event.followeeId);
      const entries = entriesForBackfill(event, recent);
      if (entries.length === 0) return;
      await deps.feed.internalUpsertEntries(entries);
      logger.info(
        { followerId: event.followerId, followeeId: event.followeeId, posts: entries.length },
        'follow backfilled',
      );
      return;
    }
    case EVENT_TYPES.postDeleted: {
      const event = parseEvent(eventType, payload);
      if (!event || event.eventType !== EVENT_TYPES.postDeleted) return;
      await deps.feed.internalDeletePostEntries(event.postId);
      logger.info({ postId: event.postId }, 'post entries removed');
      return;
    }
    case EVENT_TYPES.followDeleted: {
      const event = parseEvent(eventType, payload);
      if (!event || event.eventType !== EVENT_TYPES.followDeleted) return;
      await deps.feed.internalDeleteAuthorEntries(event.followerId, event.followeeId);
      logger.info(
        { followerId: event.followerId, followeeId: event.followeeId },
        'follow entries removed',
      );
      return;
    }
    default:
      return; // interaction/block/profile events are not feed concerns
  }
}

/** Boundary validation: unparseable payloads log + skip (poison-safe). */
function parseEvent(
  eventType: string,
  payload: Record<string, unknown> | undefined,
): DomainEvent | null {
  const parsed = eventSchemas.safeParse({ eventType, ...(payload ?? {}) });
  if (parsed.success) return parsed.data;
  logger.warn({ eventType }, 'event payload failed schema validation - skipping');
  return null;
}

/**
 * Walk the followee's timeline until the backfill window is filled or the
 * feed is exhausted. Deleted posts are already absent (posts owns that
 * filter), so no tombstones pass through.
 */
async function collectRecentPosts(
  posts: PostsApi,
  followeeId: string,
): Promise<Pick<PostCreated, 'postId' | 'authorId' | 'createdAt'>[]> {
  const collected: Pick<PostCreated, 'postId' | 'authorId' | 'createdAt'>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5 && collected.length < BACKFILL_POSTS; page++) {
    const result = await posts.internalGetAuthorPosts(followeeId, cursor, 20);
    collected.push(
      ...result.items.map((post) => ({
        postId: post.id,
        authorId: post.authorId,
        createdAt: post.createdAt,
      })),
    );
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return collected;
}
