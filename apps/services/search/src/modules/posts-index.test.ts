import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@opensearch-project/opensearch';
import type { SearchIndexDocument } from '@xitter/api-contracts';
import { PostsIndex, buildSearchBody } from './posts-index.js';

/** Minimal valid options for pure query-building assertions. */
const opts = (overrides: Partial<Parameters<typeof buildSearchBody>[0]> = {}) => ({
  q: 'hello',
  limit: 20,
  excludeAuthorIds: [],
  ...overrides,
});

// The real client rejects (async); a sync throw would bypass the .catch.
const missingIndex = () =>
  Promise.reject(
    Object.assign(new Error('index_not_found_exception'), {
      body: { error: { type: 'index_not_found_exception' }, status: 404 },
    }),
  );

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
  const index = (client: {
    updateByQuery: unknown;
    deleteByQuery: unknown;
    indices?: { refresh: unknown };
  }): PostsIndex => new PostsIndex(client as unknown as Client);

  it('refreshAuthorName is a no-op, not a 500 (profile events precede the first write)', async () => {
    const posts = index({
      updateByQuery: missingIndex,
      deleteByQuery: missingIndex,
      indices: { refresh: missingIndex },
    });
    await expect(posts.refreshAuthorName('u1', 'renamed')).resolves.toBe(0);
  });

  it('clear reports zero deleted', async () => {
    const posts = index({ updateByQuery: missingIndex, deleteByQuery: missingIndex });
    await expect(posts.clear()).resolves.toBe(0);
  });
});

describe('PostsIndex.upsertDocuments ensure-once (#109)', () => {
  const doc = (postId: string): SearchIndexDocument => ({
    postId,
    authorId: '00000000-0000-4000-8000-00000000a001',
    authorName: 'Demo Author',
    text: 'hello',
    keywords: [],
    createdAt: '2026-08-19T09:00:00.000Z',
    deletedAt: null,
  });

  function clientWith(overrides: {
    bulk: () => Promise<unknown>;
    create?: () => Promise<unknown>;
    exists?: () => Promise<{ body: boolean }>;
  }): {
    client: Client;
    create: ReturnType<typeof vi.fn>;
    bulk: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
  } {
    const create = vi.fn(overrides.create ?? (() => Promise.resolve({ body: {} })));
    const bulk = vi.fn(overrides.bulk);
    const exists = vi.fn(overrides.exists ?? (() => Promise.resolve({ body: true })));
    const client = {
      bulk,
      indices: { create, exists },
    } as unknown as Client;
    return { client, create, bulk, exists };
  }

  it('does NOT create the index when it exists (boot + existence check)', async () => {
    const { client, create } = clientWith({
      bulk: () => Promise.resolve({ body: { errors: false } }),
    });
    const posts = new PostsIndex(client);
    await posts.upsertDocuments([doc('p1'), doc('p2')]);
    await posts.upsertDocuments([doc('p3')]);

    expect(create).not.toHaveBeenCalled();
  });

  it('recreates the index WITH its definition when the reset deleted it (auto-create guard)', async () => {
    // The live bug (#118 regression): a bulk against a missing index does
    // not fail - OpenSearch auto-creates a dynamic-mapping index and every
    // analyzer-dependent query silently returns nothing. The per-call
    // existence check must recreate the index via ensure() BEFORE the bulk.
    const { client, create, bulk } = clientWith({
      exists: () => Promise.resolve({ body: false }),
      bulk: () => Promise.resolve({ body: { errors: false } }),
    });
    const posts = new PostsIndex(client);

    await expect(posts.upsertDocuments([doc('p1')])).resolves.toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(bulk).toHaveBeenCalledTimes(1);
  });

  it('re-ensures once and retries the bulk when the index vanished mid-write', async () => {
    let calls = 0;
    const { client, create } = clientWith({
      bulk: () => {
        calls += 1;
        return calls === 1 ? missingIndex() : Promise.resolve({ body: { errors: false } });
      },
    });
    const posts = new PostsIndex(client);

    await expect(posts.upsertDocuments([doc('p1')])).resolves.toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2); // failed attempt + retry
  });

  it('surfaces non-missing-index bulk errors (no retry)', async () => {
    const { client, create } = clientWith({
      bulk: () => Promise.reject(new Error('cluster gone')),
    });
    const posts = new PostsIndex(client);

    await expect(posts.upsertDocuments([doc('p1')])).rejects.toThrow('cluster gone');
    expect(create).not.toHaveBeenCalled();
  });

  it('treats an item-level index_not_found in a 200 response as missing (re-ensure + retry)', async () => {
    // Bulk item errors ride a 200 - the client never throws them. The
    // auto-created-index guard makes this unreachable in practice, but if
    // the index vanishes between the existence check and the bulk this is
    // the shape recovery must recognise.
    let calls = 0;
    const { client, create } = clientWith({
      exists: () => Promise.resolve({ body: true }),
      bulk: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({
              body: {
                errors: true,
                items: [{ index: { error: { type: 'index_not_found_exception' } } }],
              },
            })
          : Promise.resolve({ body: { errors: false } });
      },
    });
    const posts = new PostsIndex(client);

    await expect(posts.upsertDocuments([doc('p1')])).resolves.toBe(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
  });

  it('surfaces bulk item errors after the retry', async () => {
    const { client } = clientWith({
      bulk: () =>
        Promise.resolve({
          body: { errors: true, items: [{ index: { error: { type: 'mapper_parsing' } } }] },
        }),
    });
    const posts = new PostsIndex(client);

    await expect(posts.upsertDocuments([doc('p1')])).rejects.toThrow('mapper_parsing');
  });
});
