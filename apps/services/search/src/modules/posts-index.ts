import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Client } from '@opensearch-project/opensearch';
import { POSTS_INDEX, postsIndexDefinition } from '@xitter/config';
import type { SearchIndexDocument } from '@xitter/api-contracts';

/** DI token for the OpenSearch client (tests provide their own). */
export const OPENSEARCH = 'OPENSEARCH';

/** One indexed hit: everything needed to hydrate + paginate. */
export interface PostHit {
  postId: string;
  authorId: string;
  createdAt: string;
}

export interface SearchOptions {
  q: string;
  limit: number;
  /** Keyset position after (createdAt, postId) descending. */
  after?: { createdAt: string; postId: string } | null;
  /** Authors the viewer has blocked - filtered at query level (spec 03). */
  excludeAuthorIds: string[];
}

export interface SearchOutcome {
  hits: PostHit[];
  nextAfter: { createdAt: string; postId: string } | null;
}

/**
 * OpenSearch access for the posts index (spec 05 mapping, shared definition
 * from @xitter/config - the local bootstrap creates the exact same index).
 * Query building stays pure (buildSearchBody) for unit tests; this class is
 * transport only.
 */
@Injectable()
export class PostsIndex implements OnModuleInit {
  constructor(@Inject(OPENSEARCH) private readonly client: Client) {}

  /**
   * Idempotent index creation at service boot: PUT the shared definition,
   * ignore resource_already_exists. Failure is logged, not fatal - a cold
   * OpenSearch must not stop the API from serving (reads then degrade to an
   * empty page until a write path or the next boot recreates it).
   */
  async onModuleInit(): Promise<void> {
    await this.ensure().catch((err: unknown) => {
      // Boot-time unavailability is common in local dev (services and
      // dependencies start concurrently); surfaced but non-fatal.
      console.warn('[search] index ensure at boot failed:', (err as Error).message);
    });
  }

  async ensure(): Promise<void> {
    try {
      await this.client.indices.create({
        index: POSTS_INDEX,
        body: postsIndexDefinition(),
      });
    } catch (err) {
      if (isIndexAlreadyExists(err)) return;
      throw err;
    }
  }

  /**
   * Bulk upsert keyed by postId (idempotent replays converge, spec 04);
   * tombstones (deletedAt set) are upserted like any doc and filtered at
   * query time - the nightly reset reclaims them.
   */
  async upsertDocuments(documents: SearchIndexDocument[]): Promise<number> {
    if (documents.length === 0) return 0;
    await this.ensure();
    const body = documents.flatMap((doc) => [
      { index: { _index: POSTS_INDEX, _id: doc.postId } },
      {
        postId: doc.postId,
        authorId: doc.authorId,
        authorName: doc.authorName,
        text: doc.text,
        keywords: doc.keywords,
        createdAt: doc.createdAt,
        deletedAt: doc.deletedAt,
      },
    ]);
    const result = await this.client.bulk({ body, refresh: 'wait_for' });
    if (result.body.errors) {
      const reason = JSON.stringify(result.body.items?.[0]?.index?.error ?? 'unknown bulk error');
      throw new Error(`search index bulk upsert failed: ${reason}`);
    }
    return documents.length;
  }

  /**
   * Refresh the denormalised authorName on an author's documents
   * (social.profile.updated keeps the index self-contained).
   */
  async refreshAuthorName(authorId: string, authorName: string): Promise<number> {
    const result = await this.client.updateByQuery({
      index: POSTS_INDEX,
      body: {
        query: { term: { authorId } },
        script: { source: 'ctx._source.authorName = params.name', params: { name: authorName } },
      },
      conflicts: 'proceed',
      refresh: true,
    });
    return result.body.updated ?? 0;
  }

  /** Keyset-paginated full-text search, newest first on (createdAt, postId). */
  async search(options: SearchOptions): Promise<SearchOutcome> {
    const body = buildSearchBody(options);
    let result: Awaited<ReturnType<Client['search']>>;
    try {
      result = await this.client.search({ index: POSTS_INDEX, body });
    } catch (err) {
      // A missing index reads as "no results yet" (cold start after a
      // reset), not as an outage - the boot path or first write recreates it.
      if (isIndexMissing(err)) return { hits: [], nextAfter: null };
      throw err;
    }

    const hitsRaw = (result.body.hits?.hits ?? []) as Array<{
      _id: string;
      _source: { authorId: string; createdAt: string };
    }>;
    // One over-fetch proves another page exists (absent nextCursor = end).
    const hasMore = hitsRaw.length > options.limit;
    const hits = hitsRaw.slice(0, options.limit).map((hit) => ({
      postId: hit._id,
      authorId: hit._source.authorId,
      createdAt: hit._source.createdAt,
    }));

    const last = hits.at(-1);
    return { hits, nextAfter: hasMore && last ? { ...last } : null };
  }

  /** Clear every document (reset job); the mapping survives for reuse. */
  async clear(): Promise<number> {
    const result = await this.client.deleteByQuery({
      index: POSTS_INDEX,
      body: { query: { match_all: {} } },
      refresh: true,
    });
    return result.body.deleted ?? 0;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}

/**
 * Query body for a page of live posts matching `q`. Pure function - the
 * unit suite pins matching, tombstone exclusion, block filtering and
 * keyset pagination without a live OpenSearch.
 *
 * - matching: analysed text match OR exact keyword (hashtag) term
 * - filter: no tombstone (deletedAt must not exist)
 * - must_not: blocked authors (viewer-relative)
 * - sort: createdAt desc, postId desc (stable); search_after for keysets
 */
export function buildSearchBody(options: SearchOptions): Record<string, unknown> {
  const bool: Record<string, unknown> = {
    must: {
      bool: {
        should: [
          { match: { text: { query: options.q, operator: 'and' } } },
          { term: { keywords: options.q.toLowerCase() } },
        ],
        minimum_should_match: 1,
      },
    },
    filter: [{ bool: { must_not: { exists: { field: 'deletedAt' } } } }],
  };
  if (options.excludeAuthorIds.length > 0) {
    bool.must_not = [{ terms: { authorId: options.excludeAuthorIds } }];
  }
  if (options.after) {
    (bool.filter as Array<Record<string, unknown>>).push({
      bool: {
        should: [
          { range: { createdAt: { lt: options.after.createdAt } } },
          {
            bool: {
              filter: [
                { range: { createdAt: { lte: options.after.createdAt } } },
                { range: { postId: { lt: options.after.postId } } },
              ],
            },
          },
        ],
        minimum_should_match: 1,
      },
    });
  }
  return {
    // One over-fetch so nextCursor is only set when another page exists.
    size: options.limit + 1,
    query: { bool },
    sort: [{ createdAt: 'desc' }, { postId: 'desc' }],
    ...(options.after ? { search_after: [options.after.createdAt, options.after.postId] } : {}),
  };
}

interface OpenSearchErrorBody {
  error?: { type?: string; reason?: string; caused_by?: { type?: string } };
  status?: number;
}

function errorBody(err: unknown): OpenSearchErrorBody | undefined {
  const body = (err as { body?: unknown }).body;
  if (typeof body === 'object' && body !== null) return body as OpenSearchErrorBody;
  return undefined;
}

function isIndexAlreadyExists(err: unknown): boolean {
  return errorBody(err)?.error?.type === 'resource_already_exists_exception';
}

export function isIndexMissing(err: unknown): boolean {
  const body = errorBody(err);
  return body?.error?.type === 'index_not_found_exception' || body?.status === 404;
}
