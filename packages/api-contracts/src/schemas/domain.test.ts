import { describe, expect, it } from 'vitest';
import {
  MEDIA_ALT_TEXT_MAX,
  POST_TEXT_MAX,
  mediaAltTextInputSchema,
  mediaAssetSchema,
  hydratedFeedItemSchema,
  postSchema,
  usernameSchema,
} from './domain.js';
import {
  createPostRequestSchema,
  mediaLookupRequestSchema,
  searchCheckpointPutRequestSchema,
  searchIndexDocumentSchema,
  viewerStateQuerySchema,
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

// #133: optional, per-attachment alt text on the create-post request. Bare
// ids (the historical shape) must keep parsing - the field is additive.
describe('createPostRequestSchema media alt text (#133)', () => {
  const mediaId = '9e8a7b6c-1234-4abc-9def-0011223344aa';

  it('accepts bare id entries, object entries, and a mix of both', () => {
    expect(createPostRequestSchema.parse({ text: 'hi', mediaIds: [mediaId] }).mediaIds).toEqual([
      mediaId,
    ]);
    expect(
      createPostRequestSchema.parse({
        text: 'hi',
        mediaIds: [{ mediaId, altText: 'A kite over the pier' }],
      }).mediaIds,
    ).toEqual([{ mediaId, altText: 'A kite over the pier' }]);
    expect(
      createPostRequestSchema.parse({ text: 'hi', mediaIds: [mediaId, { mediaId }] }).mediaIds,
    ).toEqual([mediaId, { mediaId }]);
  });

  it('trims alt text to its stored form', () => {
    const parsed = createPostRequestSchema.parse({
      text: 'hi',
      mediaIds: [{ mediaId, altText: '  A kite over the pier  ' }],
    });
    expect(parsed.mediaIds).toEqual([{ mediaId, altText: 'A kite over the pier' }]);
  });

  it('rejects blank and over-limit alt text', () => {
    expect(
      createPostRequestSchema.safeParse({
        text: 'hi',
        mediaIds: [{ mediaId, altText: '   ' }],
      }).success,
    ).toBe(false);
    expect(
      createPostRequestSchema.safeParse({
        text: 'hi',
        mediaIds: [{ mediaId, altText: 'x'.repeat(MEDIA_ALT_TEXT_MAX + 1) }],
      }).success,
    ).toBe(false);
  });

  it('rejects attachment objects with unknown keys or bad ids', () => {
    expect(
      createPostRequestSchema.safeParse({
        text: 'hi',
        mediaIds: [{ mediaId, altText: 'fine', surprise: true }],
      }).success,
    ).toBe(false);
    expect(
      createPostRequestSchema.safeParse({ text: 'hi', mediaIds: [{ mediaId: 'nope' }] }).success,
    ).toBe(false);
  });
});

describe('mediaAltTextInputSchema (#133)', () => {
  it('accepts non-empty text and rejects empty or over-limit values', () => {
    expect(mediaAltTextInputSchema.parse(' a kite ')).toBe('a kite');
    expect(mediaAltTextInputSchema.safeParse('').success).toBe(false);
    expect(mediaAltTextInputSchema.safeParse('   ').success).toBe(false);
    expect(mediaAltTextInputSchema.safeParse('x'.repeat(MEDIA_ALT_TEXT_MAX)).success).toBe(true);
    expect(mediaAltTextInputSchema.safeParse('x'.repeat(MEDIA_ALT_TEXT_MAX + 1)).success).toBe(
      false,
    );
  });
});

// #133: altText is optional + nullable on asset responses so legacy
// snapshots and alt-less assets both parse.
describe('mediaAssetSchema altText (#133)', () => {
  const baseAsset = {
    id: '9e8a7b6c-1234-4abc-9def-0011223344bb',
    ownerId: '9e8a7b6c-1234-4abc-9def-0011223344cc',
    status: 'ready' as const,
    variants: [],
    createdAt: '2026-08-15T12:00:00.000Z',
  };

  it('accepts absent (legacy snapshot), null, and trimmed-stored text', () => {
    expect(mediaAssetSchema.parse(baseAsset).altText).toBeUndefined();
    expect(mediaAssetSchema.parse({ ...baseAsset, altText: null }).altText).toBeNull();
    expect(mediaAssetSchema.parse({ ...baseAsset, altText: 'A kite' }).altText).toBe('A kite');
  });

  it('rejects over-limit alt text', () => {
    expect(
      mediaAssetSchema.safeParse({ ...baseAsset, altText: 'x'.repeat(MEDIA_ALT_TEXT_MAX + 1) })
        .success,
    ).toBe(false);
  });
});

describe('mediaLookupRequestSchema altTexts (#133)', () => {
  const ownerId = '9e8a7b6c-1234-4abc-9def-0011223344dd';
  const mediaId = '9e8a7b6c-1234-4abc-9def-0011223344ee';

  it('accepts a lookup without altTexts (historical caller)', () => {
    expect(
      mediaLookupRequestSchema.parse({ ownerId, mediaIds: [mediaId] }).altTexts,
    ).toBeUndefined();
  });

  it('accepts altTexts keyed by requested ids and returns them trimmed', () => {
    const parsed = mediaLookupRequestSchema.parse({
      ownerId,
      mediaIds: [mediaId],
      altTexts: { [mediaId]: '  A kite over the pier  ' },
    });
    expect(parsed.altTexts).toEqual({ [mediaId]: 'A kite over the pier' });
  });

  it('rejects altTexts for ids outside mediaIds (subset rule)', () => {
    expect(
      mediaLookupRequestSchema.safeParse({
        ownerId,
        mediaIds: [mediaId],
        altTexts: { '9e8a7b6c-1234-4abc-9def-0011223344ff': 'orphan' },
      }).success,
    ).toBe(false);
  });

  it('rejects blank alt values', () => {
    expect(
      mediaLookupRequestSchema.safeParse({
        ownerId,
        mediaIds: [mediaId],
        altTexts: { [mediaId]: '' },
      }).success,
    ).toBe(false);
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

// #145: the hydrated feed item's `author` documents WHO the card renders -
// the post's own author, with the reposter on `repostedBy`. The contract
// text is the rendering rule both feed and its consumers rely on.
describe('hydratedFeedItemSchema author documentation (#145)', () => {
  it('documents author as the post author, never the reposter', () => {
    const description = hydratedFeedItemSchema.shape.author.description ?? '';
    expect(description).toContain("post's author");
    expect(description).toContain('repostedBy');
  });
});
