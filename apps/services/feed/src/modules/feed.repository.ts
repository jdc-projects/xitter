import { Inject, Injectable } from '@nestjs/common';
import { feedEntryKey, type FeedEntryInput } from '@xitter/api-contracts';
import { decodeCursor, encodeCursor } from '@xitter/service-kit';
import type { PrismaClient, Prisma } from '../generated/prisma/client.js';

/** DI token for the service-owned Prisma client (tests provide their own). */
export const FEED_PRISMA = 'FEED_PRISMA';

export type FeedPrismaClient = PrismaClient & { $disconnect(): Promise<void> };

export type FeedEntryRow = Prisma.FeedEntryGetPayload<Record<string, never>>;

export type FeedDb = Pick<PrismaClient, 'feedEntry'>;

/** Entry shape as stored: same fields as the contract input, dates as Date. */
export interface NewFeedEntry {
  userId: string;
  postId: string;
  authorId: string;
  reason: string;
  repostedById: string | null;
  postCreatedAt: Date;
}

/**
 * Prisma data access for materialised feed entries. Business rules
 * (hydration, filtering, notifications) live in FeedService; this layer is
 * queries only.
 */
@Injectable()
export class FeedRepository {
  constructor(@Inject(FEED_PRISMA) private readonly db: FeedDb) {}

  /**
   * Bulk idempotent insert (spec 04 natural-key rule): conflicts on
   * (userId, entryKey) are skipped, so event replays converge. entryKey is
   * the derived source identity (`post:{postId}` / `repost:{postId}:
   * {repostedById}`, api-contracts feedEntryKey) - repostedById cannot join a
   * unique index directly because it is NULL for reason='post' rows and
   * Postgres treats NULLs as distinct. Returns the number of rows actually
   * inserted.
   */
  upsertEntries(entries: NewFeedEntry[]): Promise<number> {
    if (entries.length === 0) return Promise.resolve(0);
    return this.db.feedEntry
      .createMany({
        data: entries.map((entry) => ({ ...entry, entryKey: keyOf(entry) })),
        skipDuplicates: true,
      })
      .then((result) => result.count);
  }

  /** Post deleted: every entry for the post (posts AND reposts) leaves every feed. */
  deleteByPost(postId: string): Promise<number> {
    return this.db.feedEntry.deleteMany({ where: { postId } }).then((r) => r.count);
  }

  /**
   * Repost undone (#8): only that reposter's repost entries for the post go -
   * the post's own entries and other users' reposts stay.
   */
  deleteRepostEntries(postId: string, repostedById: string): Promise<number> {
    return this.db.feedEntry
      .deleteMany({ where: { postId, reason: 'repost', repostedById } })
      .then((r) => r.count);
  }

  /** Unfollowed: the author's entries leave this one feed. */
  deleteByUserAndAuthor(userId: string, authorId: string): Promise<number> {
    return this.db.feedEntry.deleteMany({ where: { userId, authorId } }).then((r) => r.count);
  }

  /** Feed reset for one user (reset job / support action). */
  deleteByUser(userId: string): Promise<number> {
    return this.db.feedEntry.deleteMany({ where: { userId } }).then((r) => r.count);
  }

  /**
   * Keyset page over a user's feed, newest first on (postCreatedAt, id).
   * `excludeAuthorIds` filters blocked authors (spec 03) at query level.
   */
  async page(
    userId: string,
    cursor: string | undefined,
    limit: number,
    excludeAuthorIds: string[],
  ): Promise<{ items: FeedEntryRow[]; nextCursor: string | null }> {
    const where: Prisma.FeedEntryWhereInput = { userId };
    if (excludeAuthorIds.length > 0) {
      where.authorId = { notIn: excludeAuthorIds };
    }
    const position = cursor ? decodeCursor(cursor) : null;
    if (position) {
      const boundary = new Date(position.createdAt);
      where.OR = [
        { postCreatedAt: { lt: boundary } },
        { postCreatedAt: boundary, id: { lt: position.id } },
      ];
    }

    const rows = await this.db.feedEntry.findMany({
      where,
      orderBy: [{ postCreatedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items,
      // Cursor position = entry ordering key, not the hydrated post time.
      nextCursor:
        hasMore && last ? encodeCursor({ createdAt: last.postCreatedAt, id: last.id }) : null,
    };
  }

  /** Nightly reset: the materialised feed is fully disposable. */
  truncate(): Promise<number> {
    return this.db.feedEntry.deleteMany({}).then((r) => r.count);
  }

  /**
   * Newest entry across all feeds - the feed-freshness platform metric
   * (spec 06, #12). Null when the table is empty (fresh reset).
   */
  newestPostCreatedAt(): Promise<Date | null> {
    return this.db.feedEntry
      .aggregate({ _max: { postCreatedAt: true } })
      .then((aggregate) => aggregate._max.postCreatedAt ?? null);
  }

  toNewEntry(input: FeedEntryInput): NewFeedEntry {
    return {
      userId: input.userId,
      postId: input.postId,
      authorId: input.authorId,
      reason: input.reason,
      repostedById: input.repostedById ?? null,
      postCreatedAt: new Date(input.postCreatedAt),
    };
  }
}

function keyOf(entry: Pick<NewFeedEntry, 'postId' | 'reason' | 'repostedById'>): string {
  return feedEntryKey({
    postId: entry.postId,
    reason: entry.reason === 'repost' ? 'repost' : 'post',
    repostedById: entry.repostedById,
  });
}
