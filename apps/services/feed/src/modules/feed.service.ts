import { Inject, Injectable } from '@nestjs/common';
import type {
  FeedCheckpointPosition,
  FeedEntryInput,
  HydratedFeedItem,
  Post,
  Profile,
} from '@xitter/api-contracts';
import { assertValidCursor, profileOrPlaceholder } from '@xitter/service-kit';
import { CheckpointRepository, type CheckpointInput } from './checkpoint.repository.js';
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
    private readonly checkpoints: CheckpointRepository,
  ) {}

  /**
   * Newest-first page. Soft-deleted posts drop out during hydration; the
   * bounded refill keeps walking so a burst of deletions cannot shrink the
   * page below the requested size while older entries exist. Repost entries
   * render the ORIGINAL author as `author` (product 6.6: the card shows the
   * original post; the reposter rides `repostedBy` for attribution); replies
   * carry their target's author (`replyToAuthor`) for context.
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
      items.push(...(await this.hydrate(result.items, blocked)));
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

  /**
   * Internal (fanout worker): repost undone - only that reposter's repost
   * entries for the post go (post entries + other reposters' stay).
   */
  deleteRepostEntries(postId: string, repostedById: string): Promise<{ deleted: number }> {
    return this.repo.deleteRepostEntries(postId, repostedById).then((deleted) => ({ deleted }));
  }

  /** Internal (fanout worker): unfollowed - the author leaves this feed. */
  deleteAuthorEntries(userId: string, authorId: string): Promise<{ deleted: number }> {
    return this.repo.deleteByUserAndAuthor(userId, authorId).then((deleted) => ({ deleted }));
  }

  /** Internal (reset job / fanout): wipe one user's feed. */
  resetUser(userId: string): Promise<{ deleted: number }> {
    return this.repo.deleteByUser(userId).then((deleted) => ({ deleted }));
  }

  /** Internal (fanout worker): persist the processed position. */
  reportCheckpoint(input: CheckpointInput): Promise<void> {
    return this.checkpoints.report(input);
  }

  /** Internal (fanout worker boot): resume positions. */
  checkpointPositions(consumerKey: string): Promise<FeedCheckpointPosition[]> {
    return this.checkpoints.positions(consumerKey);
  }

  /**
   * Internal (reset job): the materialised feed is fully disposable - and
   * so are the resume checkpoints that index into it (a fresh feed must
   * not resume into a log position that predates the wipe; the reset gate
   * re-seeks the worker to the log end instead).
   */
  reseed(): Promise<{ deleted: number }> {
    return Promise.all([this.repo.truncate(), this.checkpoints.truncate()]).then(
      ([entries, checkpoints]) => ({ deleted: entries + checkpoints }),
    );
  }

  private async hydrate(
    entries: FeedEntryRow[],
    blockedAuthorIds: string[],
  ): Promise<HydratedFeedItem[]> {
    if (entries.length === 0) return [];
    const posts = await this.content.posts([...new Set(entries.map((entry) => entry.postId))]);
    // Reply context (#147): resolve the reply-target posts in ONE batched
    // lookup so their authors can ride the profile batch - never per-entry.
    const replyToIds = [
      ...new Set([...posts.values()].flatMap((post) => (post.replyToId ? [post.replyToId] : []))),
    ];
    const parents = replyToIds.length
      ? await this.content.posts(replyToIds)
      : new Map<string, Post>();
    // The rendered author is the POST's author (#145) - repost entries store
    // the reposter as the surface `authorId` (fanout filtering), so the
    // original author must join the profile batch alongside the reposter.
    const authorIds = [
      ...new Set(
        [
          ...entries.flatMap((entry) => [posts.get(entry.postId)?.authorId, entry.repostedById]),
          ...[...parents.values()].map((parent) => parent.authorId),
        ].filter((id): id is string => Boolean(id)),
      ),
    ];
    const profiles = await this.content.profiles(authorIds);
    const blocked = new Set(blockedAuthorIds);

    const items: HydratedFeedItem[] = [];
    for (const entry of entries) {
      const post = posts.get(entry.postId);
      if (!post) continue; // deleted since fanout - dropped, not rendered
      // The query filters the surface author (reposter for repost entries);
      // the ORIGINAL author is only known after hydration - filter there too
      // (product 7.6: blocked content hidden where feasible).
      if (blocked.has(post.authorId)) continue;
      items.push(this.hydrateEntry(entry, post, parents, profiles));
    }
    return items;
  }

  /** One entry -> hydrated item; parents carry the reply-context targets. */
  private hydrateEntry(
    entry: FeedEntryRow,
    post: Post,
    parents: Map<string, Post>,
    profiles: Map<string, Profile>,
  ): HydratedFeedItem {
    const repostedBy = entry.repostedById ? profiles.get(entry.repostedById) : undefined;
    // A missing parent (deleted since the reply was written) renders the
    // reply WITHOUT context rather than dropping it - it is still a
    // visible post server-side.
    const parent = post.replyToId ? parents.get(post.replyToId) : undefined;
    return {
      post,
      // The POST's author, never the entry's surface author (#145): a
      // reposted card shows the original author's identity while the
      // reposter renders separately via `repostedBy` - the web gates delete
      // on post.authorId, so identity and permission stay paired.
      author: profileOrPlaceholder(post.authorId, profiles),
      reason: entry.reason === 'repost' ? 'repost' : 'post',
      repostedBy: entry.repostedById
        ? (repostedBy ?? profileOrPlaceholder(entry.repostedById, profiles))
        : null,
      replyToAuthor: parent ? profileOrPlaceholder(parent.authorId, profiles) : null,
    };
  }
}
