import type { EachMessagePayload } from 'kafkajs';
import type { FeedEntryInput, Post, PostCreated } from '@xitter/api-contracts';
import { eventSchemas, EVENT_TYPES, type DomainEvent } from '@xitter/events';
import { createLogger } from '@xitter/observability';
import {
  BACKFILL_POSTS,
  entriesForBackfill,
  entriesForNewPost,
  entriesForRepost,
} from './entries.js';

const logger = createLogger({ service: 'fanout-worker' });

/** Upsert requests cap at 1000 entries (contract); stay safely under. */
const UPSERT_BATCH = 1_000;

/** Idempotent batches keep chunked upserts replay-safe (natural key). */
async function upsertInBatches(feed: FeedApi, entries: FeedEntryInput[]): Promise<void> {
  for (let i = 0; i < entries.length; i += UPSERT_BATCH) {
    await feed.internalUpsertEntries(entries.slice(i, i + UPSERT_BATCH));
  }
}

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
  internalDeleteRepostEntries(postId: string, repostedById: string): Promise<{ deleted: number }>;
  internalPutCheckpoint(input: {
    consumerKey: string;
    topicPartition: string;
    offset: number;
    eventId: string;
    eventAt: string;
  }): Promise<void>;
}

export interface HandlerDeps {
  social: SocialApi;
  posts: PostsApi;
  feed: FeedApi;
  /** Checkpoint identity - the consumer group id (#149). */
  consumerKey: string;
}

/**
 * Fanout dispatch (spec 04 / ADR 0003):
 *
 * - `posts.post.created` → entries for the author's followers + the author;
 * - `social.follow.created` → backfill the followee's recent posts into the
 *   follower's feed;
 * - `posts.post.deleted` → the post leaves every feed;
 * - `social.follow.deleted` → the followee's entries leave the follower's feed;
 * - `posts.interaction.created` (kind=repost) → repost entries attributed to
 *   the reposter land in their followers' feeds (#8);
 * - `posts.interaction.deleted` (kind=repost) → those entries leave;
 * - like/bookmark interactions are not feed concerns (the author ws ping is
 *   published synchronously by the posts service);
 * - block events are not consumed (product decision: history stays).
 *
 * Payloads validate against the shared event schemas at this boundary;
 * everything downstream is idempotent on the feed natural key, so
 * at-least-once redelivery converges.
 *
 * After the dispatch (whatever it did - including skipping events fanout
 * ignores), the consumed position is checkpointed to the feed service so a
 * restart outside a reset resumes exactly after this event (#149) instead
 * of the reset gate's fresh-boot seek-to-end permanently skipping the
 * downtime gap. The write happens only once the side effects succeeded:
 * a failure propagates, Kafka redelivers, and the idempotent upserts
 * converge - the checkpoint never points past unprocessed work.
 */
export async function handleEvent(
  envelope: unknown,
  raw: EachMessagePayload | undefined,
  deps: HandlerDeps,
): Promise<void> {
  await dispatch(envelope, deps);
  await checkpoint(envelope, raw, deps);
}

/**
 * Durable resume position (#149): `raw` is absent for context-free (unit)
 * calls - side effects run, nothing checkpoints.
 */
async function checkpoint(
  envelope: unknown,
  raw: EachMessagePayload | undefined,
  deps: HandlerDeps,
): Promise<void> {
  if (!raw) return;
  const { eventId, occurredAt } = envelope as { eventId: string; occurredAt: string };
  await deps.feed.internalPutCheckpoint({
    consumerKey: deps.consumerKey,
    topicPartition: `${raw.topic}:${raw.partition}`,
    offset: Number(raw.message.offset),
    eventId,
    eventAt: occurredAt,
  });
}

async function dispatch(envelope: unknown, deps: HandlerDeps): Promise<void> {
  const { eventType, payload } = (envelope ?? {}) as {
    eventType?: string;
    payload?: Record<string, unknown>;
  };

  switch (eventType) {
    case EVENT_TYPES.postCreated: {
      const event = parseEvent(eventType, payload);
      if (!event || event.eventType !== EVENT_TYPES.postCreated) return;
      const followerIds = await deps.social.internalFollowerIds(event.authorId);
      // The upsert contract caps a batch at 1000 entries; a popular author
      // would otherwise 400 and the redelivery would stall this partition.
      await upsertInBatches(deps.feed, entriesForNewPost(event, followerIds));
      logger.info({ postId: event.postId, recipients: followerIds.length + 1 }, 'post fanned out');
      return;
    }
    case EVENT_TYPES.interactionCreated: {
      const event = parseEvent(eventType, payload);
      if (!event || event.eventType !== EVENT_TYPES.interactionCreated) return;
      if (event.kind !== 'repost') return; // likes/bookmarks: no feed entries
      const followerIds = await deps.social.internalFollowerIds(event.userId);
      await upsertInBatches(deps.feed, entriesForRepost(event, followerIds));
      logger.info(
        { postId: event.postId, repostedById: event.userId, recipients: followerIds.length + 1 },
        'repost fanned out',
      );
      return;
    }
    case EVENT_TYPES.interactionDeleted: {
      const event = parseEvent(eventType, payload);
      if (!event || event.eventType !== EVENT_TYPES.interactionDeleted) return;
      if (event.kind !== 'repost') return;
      await deps.feed.internalDeleteRepostEntries(event.postId, event.userId);
      logger.info({ postId: event.postId, repostedById: event.userId }, 'repost entries removed');
      return;
    }
    case EVENT_TYPES.followCreated: {
      const event = parseEvent(eventType, payload);
      if (!event || event.eventType !== EVENT_TYPES.followCreated) return;
      const recent = await collectRecentPosts(deps.posts, event.followeeId);
      const entries = entriesForBackfill(event, recent);
      if (entries.length === 0) return;
      await upsertInBatches(deps.feed, entries);
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
      return; // like/bookmark interactions, blocks, profiles: not feed concerns
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
