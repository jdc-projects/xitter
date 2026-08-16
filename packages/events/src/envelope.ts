import { z } from 'zod';
import {
  blockCreated,
  blockDeleted,
  followCreated,
  followDeleted,
  interactionCreated,
  interactionDeleted,
  mediaProcessed,
  mediaUploaded,
  postCreated,
  postDeleted,
  profileUpdated,
} from '@xitter/api-contracts';

/** Envelope wrapped around every event payload on the wire. */
export const eventEnvelopeSchema = z.object({
  /** UUID - idempotency key for consumers (at-least-once delivery). */
  eventId: z.uuid(),
  /** Discriminator, e.g. `posts.post.created`. */
  eventType: z.string().min(1),
  /** Envelope schema version - independent of topic version. */
  eventVersion: z.literal(1),
  /** Producing service, e.g. `posts`. */
  producer: z.string().min(1),
  occurredAt: z.iso.datetime(),
  payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

/** Every event the platform emits, discriminated by `eventType`. */
export const eventSchemas = z.discriminatedUnion('eventType', [
  postCreated,
  postDeleted,
  interactionCreated,
  interactionDeleted,
  followCreated,
  followDeleted,
  blockCreated,
  blockDeleted,
  profileUpdated,
  mediaUploaded,
  mediaProcessed,
]);

export type DomainEvent = z.infer<typeof eventSchemas>;

export const EVENT_TYPES = {
  postCreated: 'posts.post.created',
  postDeleted: 'posts.post.deleted',
  interactionCreated: 'posts.interaction.created',
  interactionDeleted: 'posts.interaction.deleted',
  followCreated: 'social.follow.created',
  followDeleted: 'social.follow.deleted',
  blockCreated: 'social.block.created',
  blockDeleted: 'social.block.deleted',
  profileUpdated: 'social.profile.updated',
  mediaUploaded: 'media.media.uploaded',
  mediaProcessed: 'media.media.processed',
} as const;
