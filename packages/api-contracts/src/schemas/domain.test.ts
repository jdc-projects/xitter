import { describe, expect, it } from 'vitest';
import { POST_TEXT_MAX, postSchema, usernameSchema } from './domain.js';
import { createPostRequestSchema, viewerStateQuerySchema } from './http.js';

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

describe('viewerStateQuerySchema', () => {
  const id = (n: number) => `9e8a7b6c-1234-4abc-9def-00112233${String(n).padStart(4, '0')}`;

  it('splits the comma-separated postIds list', () => {
    expect(viewerStateQuerySchema.parse({ postIds: `${id(1)},${id(2)}` }).postIds).toEqual([
      id(1),
      id(2),
    ]);
  });

  it('rejects non-uuid entries and over-cap lists', () => {
    expect(viewerStateQuerySchema.safeParse({ postIds: 'not-a-uuid' }).success).toBe(false);
    const tooMany = Array.from({ length: 101 }, (_, n) => id(n % 10)).join(',');
    expect(viewerStateQuerySchema.safeParse({ postIds: tooMany }).success).toBe(false);
  });
});
