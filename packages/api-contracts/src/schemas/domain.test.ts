import { describe, expect, it } from 'vitest';
import { POST_TEXT_MAX, postSchema, usernameSchema } from './domain.js';
import {
  createPostRequestSchema,
  searchCheckpointPutRequestSchema,
  searchIndexDocumentSchema,
} from './http.js';

const basePost = {
  id: '9e8a7b6c-1234-4abc-9def-001122334455',
  authorId: '9e8a7b6c-1234-4abc-9def-001122334456',
  text: 'hello world',
  media: [],
  replyToId: null,
  repostOfId: null,
  counts: { replies: 0, likes: 0, reposts: 0 },
  createdAt: '2026-08-15T12:00:00.000Z',
  deletedAt: null,
};

describe('postSchema', () => {
  it('accepts a valid post', () => {
    expect(postSchema.parse(basePost).text).toBe('hello world');
  });

  it('rejects text over the product limit', () => {
    expect(postSchema.safeParse({ ...basePost, text: 'x'.repeat(POST_TEXT_MAX + 1) }).success).toBe(
      false,
    );
  });

  it('rejects empty text', () => {
    expect(postSchema.safeParse({ ...basePost, text: '' }).success).toBe(false);
  });
});

describe('usernameSchema', () => {
  it('accepts lowercase alphanumerics and underscores', () => {
    expect(usernameSchema.safeParse('demo_user1').success).toBe(true);
  });

  it('rejects uppercase and spaces', () => {
    expect(usernameSchema.safeParse('Demo User').success).toBe(false);
  });
});

describe('createPostRequestSchema', () => {
  it('defaults mediaIds and replyToId', () => {
    const parsed = createPostRequestSchema.parse({ text: 'hi' });
    expect(parsed.mediaIds).toEqual([]);
    expect(parsed.replyToId).toBeNull();
  });
});

describe('searchIndexDocumentSchema', () => {
  const baseDoc = {
    postId: basePost.id,
    authorId: basePost.authorId,
    authorName: 'Demo User',
    text: 'hello #search',
    keywords: ['#search'],
    createdAt: basePost.createdAt,
    deletedAt: null,
  };

  it('accepts a live document and defaults keywords/deletedAt', () => {
    const parsed = searchIndexDocumentSchema.parse({
      postId: baseDoc.postId,
      authorId: baseDoc.authorId,
      authorName: baseDoc.authorName,
      text: baseDoc.text,
      createdAt: baseDoc.createdAt,
    });
    expect(parsed.keywords).toEqual([]);
    expect(parsed.deletedAt).toBeNull();
  });

  it('accepts a tombstone (deletedAt set - the delete flow, spec 04)', () => {
    const parsed = searchIndexDocumentSchema.safeParse({
      ...baseDoc,
      text: '',
      keywords: [],
      createdAt: '2026-08-16T12:00:00.000Z',
      deletedAt: '2026-08-16T12:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown keys (strict contract)', () => {
    expect(searchIndexDocumentSchema.safeParse({ ...baseDoc, extra: 1 }).success).toBe(false);
  });
});

describe('searchCheckpointPutRequestSchema', () => {
  it('accepts a processed position', () => {
    const parsed = searchCheckpointPutRequestSchema.parse({
      consumerKey: 'xitter-search-index-worker',
      topicPartition: 'xitter.posts.v1:0',
      offset: 42,
      eventId: crypto.randomUUID(),
      eventAt: '2026-08-19T09:00:00.000Z',
    });
    expect(parsed.offset).toBe(42);
  });

  it('rejects negative offsets', () => {
    expect(
      searchCheckpointPutRequestSchema.safeParse({
        consumerKey: 'xitter-search-index-worker',
        topicPartition: 'xitter.posts.v1:0',
        offset: -1,
        eventId: crypto.randomUUID(),
        eventAt: '2026-08-19T09:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});
