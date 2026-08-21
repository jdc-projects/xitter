import { describe, expect, it } from 'vitest';
import type { Client } from '@opensearch-project/opensearch';
import { PostsIndex, buildSearchBody } from './posts-index.js';


/** Minimal valid options for pure query-building assertions. */
const opts = (overrides: Partial<Parameters<typeof buildSearchBody>[0]> = {}) => ({
  q: 'hello',
  limit: 20,
  excludeAuthorIds: [],
  ...overrides,
});

describe('buildSearchBody', () => {
  it('matches analysed text OR the exact keyword, newest first', () => {
    const body = buildSearchBody(opts()) as {
      size: number;
      query: { bool: Record<string, unknown> };
    };

    expect(body.size).toBe(21); // limit + 1 over-fetch
    const must = body.query.bool.must as { bool: { should: unknown[] } };
    expect(must.bool.should).toHaveLength(2);
    expect(must.bool.should).toContainEqual({
      match: { text: { query: 'hello', operator: 'and' } },
    });
    expect(must.bool.should).toContainEqual({ term: { keywords: 'hello' } });
  });

  it('excludes tombstones (no deletedAt) on every query', () => {
    const body = buildSearchBody(opts());
    const filter = (body.query as { bool: { filter: unknown[] } }).bool.filter;

    expect(JSON.stringify(filter)).toContain('"must_not":{"exists":{"field":"deletedAt"}}');
  });

  it('filters blocked authors at query level (must_not terms)', () => {
    const body = buildSearchBody(opts({ excludeAuthorIds: ['a', 'b'] })) as unknown as {
      query: { bool: { must_not: unknown[] } };
    };

    expect(body.query.bool.must_not).toContainEqual({ terms: { authorId: ['a', 'b'] } });
  });

  it('omits the must_not block when nothing is blocked', () => {
    const body = buildSearchBody(opts()) as { query: { bool: Record<string, unknown> } };
    expect(body.query.bool.must_not).toBeUndefined();
  });

  it('keyset-paginates strictly after the cursor position', () => {
    const after = { createdAt: '2026-08-19T10:00:00.000Z', postId: 'p1' };
    const body = buildSearchBody(opts({ after })) as unknown as {
      search_after: string[];
      query: { bool: { filter: unknown[] } };
    };

    expect(body.search_after).toEqual([after.createdAt, after.postId]);
    // Cursor boundary: (createdAt < X) OR (createdAt = X AND postId < p1).
    const keyset = JSON.stringify(body.query.bool.filter);
    expect(keyset).toContain(`"lt":"${after.createdAt}"`);
    expect(keyset).toContain(`"postId":{"lt":"${after.postId}"`);
  });

  it('lowercases keyword terms so hashtags match case-insensitively', () => {
    const body = buildSearchBody(opts({ q: '#Hello' })) as {
      query: { bool: { must: { bool: { should: unknown[] } } } };
    };
    expect(body.query.bool.must.bool.should).toContainEqual({ term: { keywords: '#hello' } });
  });
});

describe('PostsIndex after a reset deletes the index', () => {
  // The real client rejects (async); a sync throw would bypass the .catch.
  const missingIndex = () =>
    Promise.reject(
      Object.assign(new Error('index_not_found_exception'), {
        body: { error: { type: 'index_not_found_exception' }, status: 404 },
      }),
    );

  const index = (client: {
    updateByQuery: unknown;
    deleteByQuery: unknown;
  }): PostsIndex => new PostsIndex(client as unknown as Client);

  it('refreshAuthorName is a no-op, not a 500 (profile events precede the first write)', async () => {
    const posts = index({ updateByQuery: missingIndex, deleteByQuery: missingIndex });
    await expect(posts.refreshAuthorName('u1', 'renamed')).resolves.toBe(0);
  });

  it('clear reports zero deleted', async () => {
    const posts = index({ updateByQuery: missingIndex, deleteByQuery: missingIndex });
    await expect(posts.clear()).resolves.toBe(0);
  });
});
