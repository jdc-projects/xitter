import { Inject, Injectable } from '@nestjs/common';
import type { HydratedFeedItem, Profile, SearchIndexDocument } from '@xitter/api-contracts';
import { assertValidCursor, decodeCursor, encodeCursor } from '@xitter/service-kit';
import type { PostHit } from './posts-index.js';
import { PostsIndex } from './posts-index.js';
import { SEARCH_CONTENT, type SearchContentSource } from './search-content.js';
import type { CheckpointInput } from './checkpoint.repository.js';
import { CheckpointRepository } from './checkpoint.repository.js';

export interface SearchPageRequest {
  q: string;
  cursor?: string;
  limit: number;
}

export interface SearchPage {
  items: HydratedFeedItem[];
  nextCursor: string | null;
}

/** Hard ceiling per request (contract: limit 1..50). */
export const SEARCH_PAGE_MAX = 50;

/** Bounded refill walks when hydration drops hits (deleted since indexed). */
const MAX_WALKS = 4;

/**
 * Full-text search over the OpenSearch posts index (spec 03): the index
 * matches text and orders; post bodies and author profiles are hydrated
 * server-side from posts/social - tombstoned and blocked-author results
 * never render.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly index: PostsIndex,
    @Inject(SEARCH_CONTENT) private readonly content: SearchContentSource,
    private readonly checkpoints: CheckpointRepository,
  ) {}

  /**
   * Relevance-ranked by OpenSearch, paginated by (createdAt, postId) keyset.
   * Hits whose post vanished (deleted between index and read) drop out
   * during hydration; bounded walks refill the page so a delete burst cannot
   * shrink it while older hits exist.
   */
  async searchPosts(userId: string, page: SearchPageRequest): Promise<SearchPage> {
    assertValidCursor(page.cursor);
    const limit = Math.min(page.limit, SEARCH_PAGE_MAX);
    const blocked = await this.content.blockedAuthorIds(userId);

    const items: HydratedFeedItem[] = [];
    let after = decodeCursor(page.cursor);
    let nextCursor: string | null = null;
    for (let walk = 0; walk < MAX_WALKS && items.length < limit; walk++) {
      const space = limit - items.length;
      const result = await this.index.search({
        q: page.q,
        limit: space,
        after,
        excludeAuthorIds: blocked,
      });
      items.push(...(await this.hydrate(result.hits)));
      after = result.nextAfter;
      nextCursor = result.nextAfter
        ? encodeCursor({ createdAt: result.nextAfter.createdAt, id: result.nextAfter.postId })
        : null;
      if (!result.nextAfter) break;
    }

    return { items: items.slice(0, limit), nextCursor };
  }

  /** Internal (search-index worker): idempotent bulk upsert by postId. */
  upsertDocuments(documents: SearchIndexDocument[]): Promise<{ indexed: number }> {
    return this.index.upsertDocuments(documents).then((indexed) => ({ indexed }));
  }

  /** Internal (search-index worker): keep denormalised author names fresh. */
  refreshAuthors(authors: { authorId: string; authorName: string }[]): Promise<{ updated: number }> {
    return this.refreshAuthorsInBatches(authors);
  }

  /** Internal (search-index worker): persist the processed position. */
  reportCheckpoint(input: CheckpointInput): Promise<void> {
    return this.checkpoints.report(input);
  }

  /** Internal (search-index worker boot): resume positions. */
  checkpointPositions(consumerKey: string) {
    return this.checkpoints.positions(consumerKey);
  }

  /** Internal (reset job): clear every indexed document. */
  clearIndex(): Promise<{ deleted: number }> {
    return this.index.clear().then((deleted) => ({ deleted }));
  }

  /** Internal (reset job): truncate checkpoints (fresh index = fresh log). */
  reseed(): Promise<{ deleted: number }> {
    return this.checkpoints.truncate().then((deleted) => ({ deleted }));
  }

  private async refreshAuthorsInBatches(
    authors: { authorId: string; authorName: string }[],
  ): Promise<{ updated: number }> {
    let updated = 0;
    for (const { authorId, authorName } of authors) {
      updated += await this.index.refreshAuthorName(authorId, authorName);
    }
    return { updated };
  }

  private async hydrate(hits: PostHit[]): Promise<HydratedFeedItem[]> {
    if (hits.length === 0) return [];
    const posts = await this.content.posts([...new Set(hits.map((hit) => hit.postId))]);
    const profiles = await this.content.profiles([...new Set(hits.map((hit) => hit.authorId))]);

    const items: HydratedFeedItem[] = [];
    for (const hit of hits) {
      const post = posts.get(hit.postId);
      if (!post) continue; // deleted since indexed - dropped, not rendered
      items.push({ post, author: profileOrPlaceholder(hit.authorId, profiles) });
    }
    return items;
  }
}

/**
 * An author with no profile row (bootstrap race) still renders - the
 * placeholder validates against the profile contract, so clients stay
 * schema-clean. The profile page behind it 404s, which is honest.
 */
function profileOrPlaceholder(id: string, profiles: Map<string, Profile>): Profile {
  return (
    profiles.get(id) ?? {
      id,
      username: 'unknown',
      displayName: 'Unknown',
      bio: null,
      createdAt: new Date(0).toISOString(),
    }
  );
}
