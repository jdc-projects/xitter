import { describe, expect, it } from 'vitest';
import { TOPICS } from './topics.js';
import { eventEnvelopeSchema } from './envelope.js';

describe('topics', () => {
  it('are versioned per producing service', () => {
    expect(TOPICS.posts).toBe('xitter.posts.v1');
    expect(TOPICS.social).toBe('xitter.social.v1');
    expect(TOPICS.media).toBe('xitter.media.v1');
  });
});

describe('eventEnvelopeSchema', () => {
  const valid = {
    eventId: '9e8a7b6c-1234-4abc-9def-001122334455',
    eventType: 'posts.post.created',
    eventVersion: 1,
    producer: 'posts',
    occurredAt: '2026-08-15T12:00:00.000Z',
    payload: { postId: '9e8a7b6c-1234-4abc-9def-001122334456' },
  };

  it('accepts a valid envelope', () => {
    expect(eventEnvelopeSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an unversioned envelope', () => {
    expect(eventEnvelopeSchema.safeParse({ ...valid, eventVersion: 2 }).success).toBe(false);
  });

  it('rejects a non-uuid event id', () => {
    expect(eventEnvelopeSchema.safeParse({ ...valid, eventId: 'not-a-uuid' }).success).toBe(false);
  });
});
