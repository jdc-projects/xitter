import type { EachMessagePayload } from 'kafkajs';
import type { Profile, SearchIndexDocument } from '@xitter/api-contracts';
import { eventSchemas, EVENT_TYPES, type DomainEvent } from '@xitter/events';
import { createLogger } from '@xitter/observability';
import {
  authorRefresh,
  documentFromPostCreated,
  tombstoneFromPostDeleted,
  UNKNOWN_AUTHOR,
} from './documents.js';

const logger = createLogger({ service: 'search-index-worker' });

/** What the worker needs from the search internal API (test seam). */
export interface SearchApi {
  internalUpsertDocuments(documents: SearchIndexDocument[]): Promise<{ indexed: number }>;
  internalRefreshAuthors(authors: { authorId: string; authorName: string }[]): Promise<{
    updated: number;
  }>;
  internalPutCheckpoint(input: {
    consumerKey: string;
    topicPartition: string;
    offset: number;
    eventId: string;
    eventAt: string;
  }): Promise<void>;
}

/** What the worker needs from social (author names for documents). */
export interface SocialApi {
  internalProfiles(userIds: string[]): Promise<{ items: Profile[] }>;
}

export interface HandlerDeps {
  search: SearchApi;
  social: SocialApi;
  /** Checkpoint identity - the consumer group id (spec 05). */
  consumerKey: string;
}

/**
 * Search-index dispatch (spec 04):
 *
 * - `posts.post.created` → live document (author name resolved via social);
 * - `posts.post.deleted` → tombstone (deletedAt set; queries exclude it);
 * - `social.profile.updated` → refresh denormalised authorName everywhere;
 * - every message checkpoints its position AFTER the side effect lands, so
 *   a wiped consumer group resumes exactly after the last processed event.
 *
 * Payloads validate against the shared event schemas at this boundary;
 * document upserts are idempotent by postId, so at-least-once redelivery
 * converges.
 */
export async function handleEvent(
  envelope: unknown,
  raw: EachMessagePayload | undefined,
  deps: HandlerDeps,
): Promise<void> {
  await dispatch(envelope, deps);
  await checkpoint(envelope, raw, deps);
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
      const authorName = await resolveAuthorName(deps, event.authorId);
      await deps.search.internalUpsertDocuments([documentFromPostCreated(event, authorName)]);
      logger.info({ postId: event.postId }, 'post indexed');
      return;
    }
    case EVENT_TYPES.postDeleted: {
      const event = parseEvent(eventType, payload);
      if (!event || event.eventType !== EVENT_TYPES.postDeleted) return;
      await deps.search.internalUpsertDocuments([tombstoneFromPostDeleted(event)]);
      logger.info({ postId: event.postId }, 'post tombstoned');
      return;
    }
    case EVENT_TYPES.profileUpdated: {
      const event = parseEvent(eventType, payload);
      if (!event || event.eventType !== EVENT_TYPES.profileUpdated) return;
      await deps.search.internalRefreshAuthors([authorRefresh(event)]);
      logger.info({ profileId: event.profileId }, 'author names refreshed');
      return;
    }
    default:
      return; // interactions/follows/blocks/media are not search concerns
  }
}

/**
 * Durable resume position: written after the side effect SUCCEEDS (any
 * message, even non-actionable ones - otherwise a wiped group replays
 * noise). Any failure propagates: neither the checkpoint nor the Kafka
 * offset advances, so the message redelivers - the checkpoint must never
 * point past unprocessed work.
 */
async function checkpoint(
  envelope: unknown,
  raw: EachMessagePayload | undefined,
  deps: HandlerDeps,
): Promise<void> {
  if (!raw) return; // unit calls without a Kafka context
  const { eventId, occurredAt } = envelope as { eventId: string; occurredAt: string };
  await deps.search.internalPutCheckpoint({
    consumerKey: deps.consumerKey,
    topicPartition: `${raw.topic}:${raw.partition}`,
    offset: Number(raw.message.offset),
    eventId,
    eventAt: occurredAt,
  });
}

async function resolveAuthorName(deps: HandlerDeps, authorId: string): Promise<string> {
  try {
    const { items } = await deps.social.internalProfiles([authorId]);
    const profile = items.find((item) => item.id === authorId);
    if (profile) return profile.displayName;
  } catch (err) {
    // Social unavailable: index the post anyway (search must not wait on a
    // profile outage); the placeholder is corrected by profile.updated.
    logger.warn({ err, authorId }, 'author profile lookup failed - indexing placeholder');
  }
  return UNKNOWN_AUTHOR;
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
