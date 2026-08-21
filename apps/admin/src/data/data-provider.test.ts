import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CrudFilters, DataProvider } from '@refinedev/core';

/**
 * Provider mapping tests: Refine filters -> internal admin query params,
 * cursor-chain pagination, and per-resource endpoint shapes. adminFetch is
 * mocked (the token/session path is covered by the auth tests and e2e).
 */

const adminFetch = vi.fn();
vi.mock('./admin-fetch.js', () => ({ adminFetch: (...args: unknown[]) => adminFetch(...args) }));

const page = <T>(items: T[], nextCursor: string | null = null) => ({ items, nextCursor });
const post = (id: string) => ({ id, counts: { replies: 0, likes: 0, reposts: 0 } });

interface ProviderModule {
  dataProvider: DataProvider;
  listQuery: (
    resource: string,
    filters: CrudFilters | undefined,
  ) => Record<string, string | undefined>;
  logical: (filters: CrudFilters | undefined) => { field: string }[];
}

/** Fresh module per test: the cursor cache is module state. */
async function fresh(): Promise<ProviderModule> {
  vi.resetModules();
  adminFetch.mockReset();
  return import('./data-provider.js');
}

beforeEach(async () => {
  await fresh();
});

describe('listQuery: Refine filters -> admin query params', () => {
  it('maps posts filters and drops empties', async () => {
    const { listQuery } = await fresh();
    expect(
      listQuery('posts', [
        { field: 'text', operator: 'contains', value: 'needle' },
        { field: 'authorId', operator: 'eq', value: '' },
        { field: 'deleted', operator: 'eq', value: 'true' },
      ]),
    ).toEqual({ authorId: undefined, text: 'needle', deleted: 'true' });
  });

  it('maps media and users filters', async () => {
    const { listQuery } = await fresh();
    expect(
      listQuery('media', [
        { field: 'ownerId', operator: 'eq', value: 'u1' },
        { field: 'status', operator: 'eq', value: 'ready' },
      ]),
    ).toEqual({ ownerId: 'u1', status: 'ready' });
    expect(
      listQuery('users', [{ field: 'username', operator: 'contains', value: 'demo' }]),
    ).toEqual({ username: 'demo' });
  });

  it('ignores non-logical (or/and) filter nodes', async () => {
    const { logical, listQuery } = await fresh();
    const filters: CrudFilters = [
      { operator: 'or', value: [{ field: 'text', operator: 'contains', value: 'x' }] },
      { field: 'text', operator: 'contains', value: 'real' },
    ];
    expect(logical(filters)).toHaveLength(1);
    expect(listQuery('posts', filters).text).toBe('real');
  });
});

describe('getList: cursor pagination over opaque pages', () => {
  it('fetches page 1 without a cursor and records the next one', async () => {
    const { dataProvider } = await fresh();
    adminFetch.mockResolvedValueOnce(page([post('a'), post('b')], 'cursor-2'));

    const result = await dataProvider.getList({
      resource: 'posts',
      pagination: { currentPage: 1, pageSize: 2, mode: 'server' },
      filters: [],
    });

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(3); // 2 items + 1 phantom next page
    const [url, init] = adminFetch.mock.calls[0]!;
    expect(url).toBe('/api/posts/internal/admin/posts');
    expect(init.query).toEqual({ cursor: undefined, limit: '2' });
  });

  it('walks the recorded chain to serve page 2', async () => {
    const { dataProvider } = await fresh();
    adminFetch.mockResolvedValueOnce(page([post('a')], 'cursor-2'));
    await dataProvider.getList({
      resource: 'posts',
      pagination: { currentPage: 1, pageSize: 1, mode: 'server' },
      filters: [],
    });
    adminFetch.mockResolvedValueOnce(page([post('b')]));

    const result = await dataProvider.getList({
      resource: 'posts',
      pagination: { currentPage: 2, pageSize: 1, mode: 'server' },
      filters: [],
    });

    expect((result.data[0] as { id: string }).id).toBe('b');
    expect(result.total).toBe(2);
    const [, init] = adminFetch.mock.calls[1]!;
    expect(init.query).toEqual({ cursor: 'cursor-2', limit: '1' });
  });

  it('returns empty past the end instead of inventing a cursor', async () => {
    const { dataProvider } = await fresh();
    // Page 1 has no next cursor; re-requesting it (the chain boundary) still
    // yields none, so page 2 must come back empty rather than looping.
    adminFetch.mockResolvedValue(page([post('a')]));

    await dataProvider.getList({
      resource: 'posts',
      pagination: { currentPage: 1, pageSize: 1, mode: 'server' },
      filters: [],
    });
    const result = await dataProvider.getList({
      resource: 'posts',
      pagination: { currentPage: 2, pageSize: 1, mode: 'server' },
      filters: [],
    });

    expect(result.data).toEqual([]);
    expect(adminFetch).toHaveBeenCalledTimes(2);
    const [, init] = adminFetch.mock.calls[1]!;
    expect(init.query.cursor).toBeUndefined();
  });

  it('carries filter params into the request query', async () => {
    const { dataProvider } = await fresh();
    adminFetch.mockResolvedValueOnce(page([]));

    await dataProvider.getList({
      resource: 'media',
      pagination: { currentPage: 1, pageSize: 20, mode: 'server' },
      filters: [{ field: 'status', operator: 'eq', value: 'failed' }],
    });

    const [url, init] = adminFetch.mock.calls[0]!;
    expect(url).toBe('/api/media/internal/admin/media');
    expect(init.query).toMatchObject({ status: 'failed', limit: '20' });
  });
});

describe('getOne / deleteOne / write rejection', () => {
  it('fetches users as the follow-graph view, media and posts by id', async () => {
    const { dataProvider } = await fresh();
    adminFetch.mockResolvedValue({ profile: {}, followers: [], following: [] });
    adminFetch.mockResolvedValueOnce({ profile: {}, followers: [], following: [] });
    await dataProvider.getOne({ resource: 'users', id: 'u1' });
    expect(adminFetch.mock.calls[0]![0]).toBe('/api/social/internal/admin/users/u1/follow-graph');

    await dataProvider.getOne({ resource: 'media', id: 'm1' });
    expect(adminFetch.mock.calls[1]![0]).toBe('/api/media/internal/admin/media/m1');

    await dataProvider.getOne({ resource: 'posts', id: 'p1' });
    expect(adminFetch.mock.calls[2]![0]).toBe('/api/posts/internal/admin/posts/p1');
  });

  it('deleteOne issues DELETE against the owning service', async () => {
    const { dataProvider } = await fresh();
    adminFetch.mockResolvedValueOnce(undefined);
    const result = await dataProvider.deleteOne({ resource: 'media', id: 'm1' });
    expect(result.data).toEqual({ id: 'm1' });
    expect(adminFetch.mock.calls[0]).toEqual([
      '/api/media/internal/admin/media/m1',
      { method: 'DELETE' },
    ]);
  });

  it('rejects create/update: moderation is read/delete only', async () => {
    const { dataProvider } = await fresh();
    await expect(
      dataProvider.create({ resource: 'posts', variables: {} } as never),
    ).rejects.toThrow('read/delete only');
    await expect(
      dataProvider.update({ resource: 'posts', id: 'p1', variables: {} } as never),
    ).rejects.toThrow('read/delete only');
  });
});
