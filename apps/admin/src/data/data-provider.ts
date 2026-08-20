import type {
  BaseRecord,
  CrudFilters,
  DataProvider,
  GetListParams,
  LogicalFilter,
} from '@refinedev/core';
import {
  adminFollowGraphSchema,
  adminMediaPageSchema,
  adminPostPageSchema,
  adminUserPageSchema,
  internalMediaAssetSchema,
  postSchema,
  type AdminFollowGraph,
  type InternalMediaAsset,
  type Post,
  type ProfileWithCounts,
} from '@xitter/api-contracts';
import { adminFetch } from './admin-fetch.js';

/**
 * Refine data provider over the services' internal admin endpoints (spec 03
 * §admin). Read/delete only: moderation mutates nothing else (AC 11.3), so
 * create/update throw - the panel has no UI for them either.
 *
 * Cursor pagination: Refine/antd page numerically while the API pages by
 * opaque cursor, so the provider walks the cursor chain per
 * resource+filter+pageSize key (demo scale: lists are small).
 */

type Endpoint = { list: string; one?: string; remove?: string };

const ENDPOINTS: Record<string, Endpoint> = {
  posts: {
    list: '/api/posts/internal/admin/posts',
    one: '/api/posts/internal/admin/posts',
  },
  media: {
    list: '/api/media/internal/admin/media',
    one: '/api/media/internal/admin/media',
  },
  users: {
    // The users "record" is the follow-graph view (profile + counts + edges).
    list: '/api/social/internal/admin/users',
    one: '/api/social/internal/admin/users',
  },
};

export function logical(filters: CrudFilters | undefined): LogicalFilter[] {
  return (filters ?? []).filter((filter): filter is LogicalFilter => 'field' in filter);
}

function filterValue(filters: CrudFilters | undefined, field: string): string | undefined {
  const value = logical(filters).find((filter) => filter.field === field)?.value;
  const text = value === undefined || value === null ? '' : String(value);
  return text === '' ? undefined : text;
}

/** Refine filters → per-resource query params. */
export function listQuery(resource: string, filters: CrudFilters | undefined) {
  if (resource === 'posts') {
    return {
      authorId: filterValue(filters, 'authorId'),
      text: filterValue(filters, 'text'),
      deleted: filterValue(filters, 'deleted'),
    };
  }
  if (resource === 'media') {
    return {
      ownerId: filterValue(filters, 'ownerId'),
      status: filterValue(filters, 'status'),
    };
  }
  return { username: filterValue(filters, 'username') };
}

interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/** Cursor chain per resource+filters+pageSize (see header comment). */
const cursorCache = new Map<string, Map<number, string>>();

function cacheKey(resource: string, filters: CrudFilters | undefined, pageSize: number): string {
  return [resource, JSON.stringify(listQuery(resource, filters)), pageSize].join('|');
}

async function fetchPostsPage(query: Record<string, string | undefined>): Promise<CursorPage<Post>> {
  return adminFetch<CursorPage<Post>>(ENDPOINTS.posts!.list, { query }, (value) =>
    adminPostPageSchema.parse(value),
  );
}

async function fetchMediaPage(
  query: Record<string, string | undefined>,
): Promise<CursorPage<InternalMediaAsset>> {
  return adminFetch<CursorPage<InternalMediaAsset>>(ENDPOINTS.media!.list, { query }, (value) =>
    adminMediaPageSchema.parse(value),
  );
}

async function fetchUsersPage(
  query: Record<string, string | undefined>,
): Promise<CursorPage<ProfileWithCounts>> {
  return adminFetch<CursorPage<ProfileWithCounts>>(ENDPOINTS.users!.list, { query }, (value) =>
    adminUserPageSchema.parse(value),
  );
}

export const dataProvider: DataProvider = {
  getList: async <TData extends BaseRecord = BaseRecord>(
    params: GetListParams,
  ): Promise<{ data: TData[]; total: number }> => {
    const resource = params.resource;
    if (!ENDPOINTS[resource]) throw new Error(`Unknown resource: ${resource}`);

    const pageSize = params.pagination?.pageSize ?? 20;
    const current = params.pagination?.currentPage ?? 1;
    const key = cacheKey(resource, params.filters, pageSize);
    const chain = cursorCache.get(key) ?? new Map<number, string>();
    cursorCache.set(key, chain);

    // Page 1 has no cursor; page N's cursor was recorded when page N-1 was
    // fetched. Start at the furthest page we can serve directly and walk
    // forward only when the requested page lies beyond it.
    let page = 1;
    let cursor = chain.get(page);
    if (current > 1) {
      const furthest = [...chain.keys()].reduce((max, n) => Math.max(max, n), 1);
      page = Math.min(furthest, current);
      cursor = chain.get(page);
    }

    const query = { ...listQuery(resource, params.filters), cursor, limit: pageSize.toString() };
    let result =
      resource === 'posts'
        ? await fetchPostsPage(query)
        : resource === 'media'
          ? await fetchMediaPage(query)
          : await fetchUsersPage(query);
    if (result.nextCursor) chain.set(page + 1, result.nextCursor);

    while (page < current) {
      const next = chain.get(page + 1);
      if (!next) return { data: [], total: page * pageSize }; // ran off the end
      page += 1;
      result =
        resource === 'posts'
          ? await fetchPostsPage({ ...query, cursor: next })
          : resource === 'media'
            ? await fetchMediaPage({ ...query, cursor: next })
            : await fetchUsersPage({ ...query, cursor: next });
      if (result.nextCursor) chain.set(page + 1, result.nextCursor);
    }

    // antd needs a number; cursor APIs have no totals. Page-end + one when a
    // next page exists keeps Previous/Next honest.
    const total = (current - 1) * pageSize + result.items.length + (result.nextCursor ? 1 : 0);
    return { data: result.items as unknown as TData[], total };
  },

  getOne: async <TData extends BaseRecord = BaseRecord>(params: {
    resource: string;
    id: string | number;
  }): Promise<{ data: TData }> => {
    const endpoint = ENDPOINTS[params.resource];
    if (!endpoint?.one) throw new Error(`Unknown resource: ${params.resource}`);
    if (params.resource === 'posts') {
      const data = await adminFetch<Post>(`${endpoint.one}/${params.id}`, {}, (value) =>
        postSchema.parse(value),
      );
      return { data: data as unknown as TData };
    }
    if (params.resource === 'media') {
      const data = await adminFetch<InternalMediaAsset>(
        `${endpoint.one}/${params.id}`,
        {},
        (value) => internalMediaAssetSchema.parse(value),
      );
      return { data: data as unknown as TData };
    }
    const graph = await adminFetch<AdminFollowGraph>(
      `${endpoint.one}/${params.id}/follow-graph`,
      {},
      (value) => adminFollowGraphSchema.parse(value),
    );
    return { data: graph as unknown as TData };
  },

  create: async () => {
    throw new Error('Admin panel is read/delete only');
  },

  update: async () => {
    throw new Error('Admin panel is read/delete only');
  },

  deleteOne: async <TData extends BaseRecord = BaseRecord>(params: {
    resource: string;
    id: string | number;
  }): Promise<{ data: TData }> => {
    const endpoint = ENDPOINTS[params.resource];
    if (!endpoint) throw new Error(`Unknown resource: ${params.resource}`);
    await adminFetch<undefined>(`${endpoint.list}/${params.id}`, { method: 'DELETE' });
    return { data: { id: params.id } as TData };
  },

  getApiUrl: () => '/api',

  custom: async <TData extends BaseRecord = BaseRecord>(params: {
    url: string;
    method: 'get' | 'post' | 'delete' | 'put' | 'patch' | 'head' | 'options';
  }) => {
    const data = await adminFetch<TData>(params.url, { method: params.method.toUpperCase() });
    return { data };
  },
};
