import { Inject, Injectable } from '@nestjs/common';
import type { FeedEntryInput, HydratedFeedItem } from '@xitter/api-contracts';
import { assertValidCursor, profileOrPlaceholder } from '@xitter/service-kit';
import { CONTENT_HYDRATOR, type ContentHydrator } from './content-hydrator.js';
import { FEED_REALTIME, type FeedRealtime } from './feed-realtime.js';
import { FeedRepository, type FeedEntryRow } from './feed.repository.js';

export interface FeedPageRequest {
  cursor?: string;
  limit: number;
}

export interface FeedPage {
  items: HydratedFeedItem[];
  nextCursor: string | null;
}

/** Hard ceiling per request (contract: limit 1..50). */
export const FEED_PAGE_MAX = 50;

/**
 * The materialised home feed (ADR 0003): fanout stores ids + ordering
 * columns, reads hydrate post bodies (posts) and authors (social)
 * server-side. Content rule (spec 03): followed + own posts, newest first;
 * deleted posts and blocked authors never render.
 */
@Injectable()
export class FeedService {
  constructor(
    private readonly repo: FeedRepository,
    @Inject(CONTENT_HYDRATOR) private readonly content: ContentHydrator,
    @Inject(FEED_REALTIME) private readonly realtime: FeedRealtime,
  ) {}

  /**
   * Newest-first page. Soft-deleted posts drop out during hydration; the
   * bounded refill keeps walking so a burst of deletions cannot shrink the
   * page below the requested size while older entries exist.
   */
  async getFeed(userId: string, page: FeedPageRequest): Promise<FeedPage> {
    assertValidCursor(page.cursor);
    const limit = Math.min(page.limit, FEED_PAGE_MAX);
    const blocked = await this.content.blockedAuthorIds(userId);

    const items: HydratedFeedItem[] = [];
    let cursor = page.cursor;
    let nextCursor: string | null = null;
    // 4 walks cover any realistic delete burst; beyond that, serve short.
    for (let walk = 0; walk < 4 && items.length < limit; walk++) {
      const space = limit - items.length;
      const result = await this.repo.page(userId, cursor, space, blocked);
      items.push(...(await this.hydrate(result.items)));
      cursor = result.nextCursor ?? undefined;
      nextCursor = result.nextCursor;
      if (!result.nextCursor) break;
    }

    return { items: items.slice(0, limit), nextCursor };
  }

  /**
   * Internal (fanout worker): bulk idempotent upsert. Notifies affected
   * users over Valkey when rows land so connected clients refetch (spec 03:
   * notifications only, no payloads).
   */
  async upsertEntries(inputs: FeedEntryInput[]): Promise<{ inserted: number }> {
    const inserted = await this.repo.upsertEntries(
      inputs.map((input) => this.repo.toNewEntry(input)),
    );
    if (inserted > 0) {
      await this.realtime.notify([...new Set(inputs.map((input) => input.userId))]);
    }
    return { inserted };
  }

  /** Internal (fanout worker): post deleted - entries leave every feed. */
  deletePostEntries(postId: string): Promise<{ deleted: number }> {
    return this.repo.deleteByPost(postId).then((deleted) => ({ deleted }));
  }

  /** Internal (fanout worker): unfollowed - the author leaves this feed. */
  deleteAuthorEntries(userId: string, authorId: string): Promise<{ deleted: number }> {
    return this.repo.deleteByUserAndAuthor(userId, authorId).then((deleted) => ({ deleted }));
  }

  /** Internal (reset job / fanout): wipe one user's feed. */
  resetUser(userId: string): Promise<{ deleted: number }> {
    return this.repo.deleteByUser(userId).then((deleted) => ({ deleted }));
  }

  /** Internal (reset job): the materialised feed is fully disposable. */
  reseed(): Promise<{ deleted: number }> {
    return this.repo.truncate().then((deleted) => ({ deleted }));
  }

  private async hydrate(entries: FeedEntryRow[]): Promise<HydratedFeedItem[]> {
    if (entries.length === 0) return [];
    const posts = await this.content.posts([...new Set(entries.map((entry) => entry.postId))]);
    const authorIds = [...new Set(entries.map((entry) => entry.authorId))];
    const profiles = await this.content.profiles(authorIds);

    const items: HydratedFeedItem[] = [];
    for (const entry of entries) {
      const post = posts.get(entry.postId);
      if (!post) continue; // deleted since fanout - dropped, not rendered
      items.push({ post, author: profileOrPlaceholder(entry.authorId, profiles) });
    }
    return items;
  }
}
