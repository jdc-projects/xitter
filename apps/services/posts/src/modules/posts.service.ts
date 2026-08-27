import { Inject, Injectable } from '@nestjs/common';
import {
  createPostRequestSchema,
  type AdminPostsListQuery,
  type CreatePostRequest,
  type Interaction,
  type InteractionKind,
  type MediaAsset,
  type Post,
  type PostViewerState,
} from '@xitter/api-contracts';
import { createLogger } from '@xitter/observability';
import { assertValidCursor, badRequest, forbidden, notFound } from '@xitter/service-kit';
import { INTERACTION_REALTIME, type InteractionRealtime } from './interaction-realtime.js';
import { MEDIA_CHECKER, type MediaChecker } from './media-checker.js';
import { POSTS_EVENTS, type PostsEvents } from './posts-events.js';
import { PostsRepository, type PostRow } from './posts.repository.js';
import { RELATIONSHIP_CHECKER, type RelationshipChecker } from './relationship-checker.js';
import { deriveViewerState } from './viewer-state.js';

const logger = createLogger({ service: 'posts' });

export interface PageRequest {
  cursor?: string;
  limit: number;
}

export interface PostPage {
  items: Post[];
  nextCursor: string | null;
}

/** Admin principal as the audit trail records it (who/what/when). */
export interface AdminActor {
  actorId: string;
  actorName: string;
}

/**
 * Posts, replies, and (from #8) interactions - the rules from spec 03 /
 * product 02 §4-6:
 *
 * - `text` is required, 1-512 chars (contract schema, POST_TEXT_MAX);
 * - `mediaIds` resolve through media's internal API: existence, ownership
 *   and ready-status at creation; a denormalised snapshot rides the row;
 * - deletes are soft: deletedAt set, hidden from every read path;
 * - only the author may delete their own post;
 * - a reply is rejected when a block exists in EITHER direction between the
 *   replier and the parent's author (social internal check);
 * - events are best-effort after commit: a Kafka outage logs but never fails
 *   the mutation (at-least-once consumers must be idempotent anyway).
 */
@Injectable()
export class PostsService {
  constructor(
    private readonly repo: PostsRepository,
    @Inject(POSTS_EVENTS) private readonly events: PostsEvents,
    @Inject(RELATIONSHIP_CHECKER) private readonly relationships: RelationshipChecker,
    @Inject(MEDIA_CHECKER) private readonly media: MediaChecker,
    @Inject(INTERACTION_REALTIME) private readonly realtime: InteractionRealtime,
  ) {}

  async create(authorId: string, input: CreatePostRequest): Promise<Post> {
    // The controller validates via the same schema; re-parsing here keeps the
    // 1..512 / uuid / max-4 rules true for every caller (seed, tests, future
    // internal paths), not just HTTP.
    const parsed = createPostRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw badRequest('Post validation failed', { fields: parsed.error.flatten() });
    }
    input = parsed.data;

    const parent = input.replyToId
      ? await this.requireReplyTarget(input.replyToId, authorId)
      : null;

    // mediaIds must exist, be owned by the author, and be ready (processed)
    // at attach time - the snapshot taken here is what reads render. Entries
    // may carry per-asset alt text (#133); it rides the same lookup so
    // validation (trim/non-empty) and storage both happen in media.
    const mediaIds = input.mediaIds.map((entry) =>
      typeof entry === 'string' ? entry : entry.mediaId,
    );
    const altTexts: Record<string, string> = {};
    for (const entry of input.mediaIds) {
      if (typeof entry !== 'string' && entry.altText !== undefined) {
        altTexts[entry.mediaId] = entry.altText;
      }
    }

    const requested = [...new Set(mediaIds)];
    const media =
      requested.length > 0 ? await this.requireAttachable(authorId, requested, altTexts) : [];

    const row = await this.repo.createPost({
      authorId,
      text: input.text,
      mediaIds,
      media,
      replyToId: parent?.id ?? null,
    });
    const post = this.toPost(row);

    await this.emitSafe(
      'posts.post.created',
      {
        postId: row.id,
        authorId,
        text: row.text,
        mediaIds: row.mediaIds,
        replyToId: row.replyToId,
        repostOfId: row.repostOfId,
        createdAt: row.createdAt.toISOString(),
      },
      row.id,
    );
    return post;
  }

  /** Own posts only; soft delete keeps the row (and interactions) for #8. */
  async remove(callerId: string, postId: string): Promise<void> {
    const row = await this.repo.findPost(postId);
    if (!row || row.deletedAt) throw notFound('Post not found');
    if (row.authorId !== callerId) {
      throw forbidden('You can only delete your own posts');
    }
    const deleted = await this.repo.softDelete(postId);
    if (!deleted) return; // concurrent delete already won - idempotent 204

    await this.emitSafe(
      'posts.post.deleted',
      {
        postId,
        authorId: callerId,
        deletedAt: deleted.deletedAt?.toISOString() ?? new Date().toISOString(),
      },
      postId,
    );
  }

  /** Deleted posts are indistinguishable from missing ones. */
  async getPost(postId: string): Promise<Post> {
    const row = await this.repo.findVisiblePost(postId);
    if (!row) throw notFound('Post not found');
    return this.toPost(row);
  }

  /** Author timeline, newest first, soft-deleted rows excluded. */
  async userPosts(authorId: string, page: PageRequest): Promise<PostPage> {
    assertValidCursor(page.cursor);
    const result = await this.repo.authorPosts(authorId, page.cursor, page.limit);
    return { items: result.items.map((row) => this.toPost(row)), nextCursor: result.nextCursor };
  }

  /** Thread order: chronological (oldest first, spec 03). */
  async postReplies(postId: string, page: PageRequest): Promise<PostPage> {
    await this.getPost(postId); // 404 for deleted/missing parents
    assertValidCursor(page.cursor);
    const result = await this.repo.replies(postId, page.cursor, page.limit);
    return { items: result.items.map((row) => this.toPost(row)), nextCursor: result.nextCursor };
  }

  /** Internal (feed hydration): visible posts by id, any author. */
  async lookupPosts(postIds: string[]): Promise<Post[]> {
    const rows = await this.repo.visiblePosts(postIds);
    return rows.map((row) => this.toPost(row));
  }

  /**
   * Interact with a post (#8, product 6). Idempotent: a repeat create
   * resolves to the stored interaction without re-counting or re-emitting.
   * Blocked users cannot interact with the blocker's posts (any kind) -
   * same either-direction check as replies. Reposting your own post is
   * allowed; reposts target posts, never other reposts (reposts are
   * interactions, not posts - chains are structurally impossible).
   */
  async interact(callerId: string, postId: string, kind: InteractionKind): Promise<Interaction> {
    const post = await this.repo.findVisiblePost(postId);
    if (!post) throw notFound('Post not found');

    if (post.authorId !== callerId) {
      const blocked = await this.relationships.blockedEitherWay(callerId, post.authorId);
      if (blocked) {
        throw forbidden('Cannot interact: a block exists between these accounts');
      }
    }

    const { row, created } = await this.repo.createInteraction({
      kind,
      postId,
      userId: callerId,
    });

    if (created) {
      await this.emitSafe(
        'posts.interaction.created',
        {
          interactionId: row.id,
          kind,
          postId,
          userId: callerId,
          createdAt: row.createdAt.toISOString(),
        },
        postId,
      );
      // The author's ws ping (product 5.5): likes/reposts light up for the
      // author without creating feed entries. Self-interactions and private
      // bookmarks never ping (a self-ping is noise; bookmark privacy).
      if ((kind === 'like' || kind === 'repost') && post.authorId !== callerId) {
        await this.realtime.notifyAuthor(post.authorId);
      }
    }

    return {
      kind,
      postId,
      userId: callerId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * Undo an interaction (own rows only; idempotent 204 when absent). Block
   * checks are deliberately NOT applied - undo removes the caller's own
   * footprint and must always be possible.
   */
  async removeInteraction(callerId: string, postId: string, kind: InteractionKind): Promise<void> {
    // findPost (not findVisiblePost): undoing a repost/like of a since-
    // soft-deleted post is legitimate cleanup, indistinguishable from 204.
    const post = await this.repo.findPost(postId);
    if (!post) throw notFound('Post not found');

    const removed = await this.repo.deleteInteraction({ kind, postId, userId: callerId });
    if (removed) {
      await this.emitSafe(
        'posts.interaction.deleted',
        { kind, postId, userId: callerId, deletedAt: new Date().toISOString() },
        postId,
      );
    }
  }

  /** The caller's private bookmark list, newest first (product 6.2). */
  async bookmarks(callerId: string, page: PageRequest): Promise<PostPage> {
    assertValidCursor(page.cursor);
    const result = await this.repo.bookmarks(callerId, page.cursor, page.limit);
    return { items: result.items.map((row) => this.toPost(row)), nextCursor: result.nextCursor };
  }

  /** The caller's like/repost/bookmark flags for a batch of posts. */
  async viewerState(callerId: string, postIds: string[]): Promise<PostViewerState[]> {
    const rows = await this.repo.interactionsForPosts(callerId, postIds);
    return deriveViewerState(postIds, rows);
  }

  /** Internal (reset job): wipe posts + interactions; reseed via seed script. */
  async reseed(): Promise<void> {
    await this.repo.truncate();
  }

  // -- Admin moderation (T10). Guard already established the actor carries
  // an admin role; the audit row is the accountability record.

  /** Filtered moderation list (tombstones included unless filtered out). */
  async adminListPosts(query: AdminPostsListQuery): Promise<PostPage> {
    assertValidCursor(query.cursor);
    const { authorId, text, deleted } = query;
    const result = await this.repo.adminPosts(
      { authorId, text, deleted },
      query.cursor,
      query.limit,
    );
    return { items: result.items.map((row) => this.toPost(row)), nextCursor: result.nextCursor };
  }

  /** Any post, deleted or not (moderation must see tombstones). */
  async adminGetPost(postId: string): Promise<Post> {
    const row = await this.repo.findPost(postId);
    if (!row) throw notFound('Post not found');
    return this.toPost(row);
  }

  /**
   * Moderation delete. Both modes emit `posts.post.deleted` so feeds (and
   * any index) drop the post exactly like an author delete (AC 11.5).
   */
  async adminRemovePost(actor: AdminActor, postId: string, hard: boolean): Promise<void> {
    const deleted = hard
      ? await this.repo.adminHardDelete(postId, this.audit(actor, 'post.hard-delete'))
      : await this.repo.adminSoftDelete(postId, this.audit(actor, 'post.soft-delete'));
    if (!deleted) throw notFound('Post not found');

    await this.emitSafe(
      'posts.post.deleted',
      {
        postId,
        authorId: deleted.authorId,
        deletedAt: new Date().toISOString(),
      },
      postId,
    );
  }

  /**
   * Moderation restore: the post becomes visible again on every read path,
   * and re-emitting `posts.post.created` re-materialises feed entries at the
   * post's original chronological position (fanout upserts are idempotent).
   */
  async adminRestorePost(actor: AdminActor, postId: string): Promise<Post> {
    const restored = await this.repo.adminRestore(postId, this.audit(actor, 'post.restore'));
    if (!restored) throw notFound('Post not found (or not deleted)');
    const post = this.toPost(restored);

    await this.emitSafe(
      'posts.post.created',
      {
        postId: restored.id,
        authorId: restored.authorId,
        text: restored.text,
        mediaIds: restored.mediaIds,
        replyToId: restored.replyToId,
        repostOfId: restored.repostOfId,
        createdAt: restored.createdAt.toISOString(),
      },
      restored.id,
    );
    return post;
  }

  /** Moderation audit trail (who deleted/restored what, when). */
  async adminAudit(page: PageRequest) {
    assertValidCursor(page.cursor);
    return this.repo.adminAudit(page.cursor, page.limit);
  }

  private audit(actor: AdminActor, action: string) {
    return {
      actorId: actor.actorId,
      actorName: actor.actorName,
      action,
      targetId: '', // filled by the repository with the concrete row id
    };
  }

  /**
   * A reply target must exist and be visible, and no block may exist between
   * the replier and the parent's author in either direction (product 6.4).
   */
  private async requireReplyTarget(replyToId: string, replierId: string): Promise<PostRow> {
    const parent = await this.repo.findVisiblePost(replyToId);
    if (!parent) throw notFound('Post not found');

    if (parent.authorId !== replierId) {
      const blocked = await this.relationships.blockedEitherWay(replierId, parent.authorId);
      if (blocked) {
        throw forbidden('Cannot reply: a block exists between these accounts');
      }
    }
    return parent;
  }

  /**
   * Every requested id must resolve to a ready asset owned by the author.
   * The media checker fails closed when media is unreachable; here the
   * response decides per-asset (missing / not-yours / still-pending).
   * altTexts (#133) ride the same call and land on the resolved snapshot.
   */
  private async requireAttachable(
    authorId: string,
    mediaIds: string[],
    altTexts: Record<string, string> = {},
  ): Promise<MediaAsset[]> {
    const resolved = await this.media.resolveForAttach(authorId, mediaIds, altTexts);
    const ready = new Set(resolved.filter((asset) => asset.status === 'ready').map((a) => a.id));
    const invalid = mediaIds.filter((id) => !ready.has(id));
    if (invalid.length > 0) {
      throw badRequest('Attached images must be processed and ready', {
        invalidMediaIds: invalid,
      });
    }
    // Preserve the request order for deterministic rendering.
    return mediaIds.map((id) => resolved.find((asset) => asset.id === id)!);
  }

  private toPost(row: PostRow): Post {
    return {
      id: row.id,
      authorId: row.authorId,
      text: row.text,
      // Snapshot taken at creation (see create): variants are immutable, so
      // this is the render truth without a media call per read.
      media: (row.media ?? []) as MediaAsset[],
      replyToId: row.replyToId,
      repostOfId: row.repostOfId,
      counts: this.repo.toCounts(row),
      createdAt: row.createdAt.toISOString(),
      deletedAt: row.deletedAt?.toISOString() ?? null,
    };
  }

  private async emitSafe(
    eventType: Parameters<PostsEvents['emit']>[0],
    payload: Record<string, unknown>,
    key?: string,
  ): Promise<void> {
    try {
      await this.events.emit(eventType, payload, key);
    } catch (err) {
      // The DB write already committed; a missed event degrades downstream
      // views until the nightly reset rather than failing the user's action.
      logger.error({ err, eventType }, 'event emission failed');
    }
  }
}
