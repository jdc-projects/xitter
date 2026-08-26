import type { EachMessagePayload } from 'kafkajs';
import type { Profile, SearchIndexDocument } from '@xitter/api-contracts';
import { eventSchemas, EVENT_TYPES, type DomainEvent } from '@xitter/events';
import { createLogger } from '@xitter/observability';
import {
  documentFromPostCreated,
  tombstoneFromPostDeleted,
  UNKNOWN_AUTHOR,
} from './documents.js';

const logger = createLogger({ service: 'search-index-worker' });

/** Contract ceilings (@xitter/api-contracts): bulk upsert / lookup / rename. */
export const UPSERT_MAX = 1000;
export const PROFILES_LOOKUP_MAX = 100;
export const AUTHORS_REFRESH_MAX = 100;

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

/** One parsed event plus its Kafka position (the message-mode payload shape). */
export interface BatchEvent {
  envelope: unknown;
  /** Absent for context-free (unit) calls: side effects run, nothing checkpoints. */
  raw?: EachMessagePayload;
}

/**
 * Work accumulated from one fetch batch, in event order. Documents are
 * deduped by postId keeping the LAST occurrence (creates followed by
 * deletes of the same post collapse to the tombstone; distinct postIds
 * never interact). Author renames keep the last name per author.
 */
export interface PendingBatch {
  documents: SearchIndexDocument[];
  /** Author ids the documents' names must be resolved for (unique, ordered). */
  authorIds: string[];
  /** profileId -> latest displayName seen in the batch. */
  renames: Map<string, string>;
  /** The batch's last event - the only checkpoint candidate. */
  last?: { eventId: string; eventAt: string; offset: number };
}

export function emptyBatch(): PendingBatch {
  return { documents: [], authorIds: [], renames: new Map() };
}

/**
 * Search-index batch dispatch (spec 04): accumulate one fetch batch's
 * events, then land the side effects in event order - documents first
 * (one bulked social lookup for every author, then one bulk upsert per
 * contract-sized chunk), then author renames - and only afterwards
 * checkpoint the batch's last offset.
 *
 * Ordering rationale: renames are `update_by_query` over existing docs, so
 * running them after the upserts preserves per-event semantics both ways -
 * a post created before its author's rename in the same batch is written
 * with the fresh (lookup happens at flush time) name and then renamed
 * again to the same value; a rename before a create converges the same
 * way. Payloads validate against the shared event schemas at this
 * boundary; document upserts are idempotent by postId, so at-least-once
 * redelivery of a whole batch (the only redelivery granularity - offsets
 * commit per batch) converges.
 */
export async function handleBatch(
  events: BatchEvent[],
  context: { topic: string; partition: number },
  deps: HandlerDeps,
): Promise<void> {
  const batch = collectBatch(events);
  await flushBatch(batch, deps);
  await checkpoint(batch, context, deps);
}

/** Message-mode entry (single event = one-event batch). */
export async function handleEvent(
  envelope: unknown,
  raw: EachMessagePayload | undefined,
  deps: HandlerDeps,
): Promise<void> {
  if (!raw) {
    // No Kafka context: side effects only (matches the old dispatch-then-
    // skip-checkpoint behaviour for envelope-only unit calls).
    await flushBatch(collectBatch([{ envelope }]), deps);
    return;
  }
  await handleBatch([{ envelope, raw }], { topic: raw.topic, partition: raw.partition }, deps);
}

/** Pure accumulation: no HTTP, so ordering/dedupe logic is unit-testable. */
export function collectBatch(events: BatchEvent[]): PendingBatch {
  const batch = emptyBatch();
  const lastByPost = new Map<string, SearchIndexDocument>();
  for (const { envelope, raw } of events) {
    const { eventType, payload } = (envelope ?? {}) as {
      eventType?: string;
      payload?: Record<string, unknown>;
    };
    const event = parseEvent(eventType, payload);
    if (event) {
      if (event.eventType === EVENT_TYPES.postCreated) {
        const doc = documentFromPostCreated(event, UNKNOWN_AUTHOR); // name filled at flush
        lastByPost.set(doc.postId, doc);
        if (!batch.authorIds.includes(event.authorId)) batch.authorIds.push(event.authorId);
      } else if (event.eventType === EVENT_TYPES.postDeleted) {
        lastByPost.set(event.postId, tombstoneFromPostDeleted(event));
      } else if (event.eventType === EVENT_TYPES.profileUpdated) {
        batch.renames.set(event.profileId, event.displayName);
      }
      // interactions/follows/blocks/media are not search concerns
    }
    const { eventId, occurredAt } = envelope as { eventId: string; occurredAt: string };
    if (raw) batch.last = { eventId, eventAt: occurredAt, offset: Number(raw.message.offset) };
  }
  batch.documents = [...lastByPost.values()];
  return batch;
}

/**
 * Land the side effects: author names (one batched lookup per
 * contract-sized chunk of ids), then the bulk upsert, then renames. Any
 * failure propagates BEFORE the checkpoint, so the batch redelivers whole.
 */
async function flushBatch(batch: PendingBatch, deps: HandlerDeps): Promise<void> {
  if (batch.documents.length > 0) {
    const names = await resolveAuthorNames(batch.authorIds, deps);
    for (const doc of batch.documents) {
      if (doc.deletedAt === null) doc.authorName = names.get(doc.authorId) ?? UNKNOWN_AUTHOR;
    }
    for (const chunk of chunks(batch.documents, UPSERT_MAX)) {
      await deps.search.internalUpsertDocuments(chunk);
      logger.info({ documents: chunk.length }, 'documents indexed');
    }
  }
  if (batch.renames.size > 0) {
    const authors = [...batch.renames].map(([authorId, authorName]) => ({ authorId, authorName }));
    for (const chunk of chunks(authors, AUTHORS_REFRESH_MAX)) {
      await deps.search.internalRefreshAuthors(chunk);
      logger.info({ authors: chunk.length }, 'author names refreshed');
    }
  }
}

/**
 * Durable resume position: written after the side effects SUCCEED, for the
 * batch's last event only (everything before it landed in the same flush).
 * Any failure propagates: neither the checkpoint nor the Kafka offsets
 * advance, so the whole batch redelivers - the checkpoint must never point
 * past unprocessed work.
 */
async function checkpoint(
  batch: PendingBatch,
  context: { topic: string; partition: number },
  deps: HandlerDeps,
): Promise<void> {
  if (!batch.last) return; // empty batch (all-poison runBatch skips us entirely)
  await deps.search.internalPutCheckpoint({
    consumerKey: deps.consumerKey,
    topicPartition: `${context.topic}:${context.partition}`,
    offset: batch.last.offset,
    eventId: batch.last.eventId,
    eventAt: batch.last.eventAt,
  });
}

/**
 * Resolve every author in the batch with as few lookups as the contract
 * allows. Social unavailable: index anyway with placeholders (search must
 * not wait on a profile outage) - profile.updated corrects them later,
 * same trade-off as the per-event path had.
 */
async function resolveAuthorNames(
  authorIds: string[],
  deps: HandlerDeps,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (authorIds.length === 0) return names;
  try {
    for (const chunk of chunks(authorIds, PROFILES_LOOKUP_MAX)) {
      const { items } = await deps.social.internalProfiles(chunk);
      for (const profile of items) names.set(profile.id, profile.displayName);
    }
  } catch (err) {
    logger.warn({ err }, 'author profile lookup failed - indexing placeholders');
  }
  return names;
}

/** Split into contract-sized slices, preserving order. */
export function chunks<T>(items: T[], max: number): T[][] {
  if (items.length <= max) return items.length === 0 ? [] : [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += max) out.push(items.slice(i, i + max));
  return out;
}

/** Boundary validation: unparseable payloads log + skip (poison-safe). */
function parseEvent(
  eventType: string | undefined,
  payload: Record<string, unknown> | undefined,
): DomainEvent | null {
  const parsed = eventSchemas.safeParse({ eventType, ...(payload ?? {}) });
  if (parsed.success) return parsed.data;
  logger.warn({ eventType }, 'event payload failed schema validation - skipping');
  return null;
}
