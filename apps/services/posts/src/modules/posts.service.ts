import { Inject, Injectable } from '@nestjs/common';
import {
  createPostRequestSchema,
  type CreatePostRequest,
  type MediaAsset,
  type Post,
} from '@xitter/api-contracts';
import { createLogger } from '@xitter/observability';
import { assertValidCursor, badRequest, forbidden, notFound } from '@xitter/service-kit';
import { MEDIA_CHECKER, type MediaChecker } from './media-checker.js';
import { POSTS_EVENTS, type PostsEvents } from './posts-events.js';
import { PostsRepository, type PostRow } from './posts.repository.js';
import { RELATIONSHIP_CHECKER, type RelationshipChecker } from './relationship-checker.js';

const logger = createLogger({ service: 'posts' });

export interface PageRequest {
  cursor?: string;
  limit: number;
}

export interface PostPage {
  items: Post[];
  nextCursor: string | null;
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
    // at attach time - the snapshot taken here is what reads render.
    const requested = [...new Set(input.mediaIds)];
    const media =
      requested.length > 0 ? await this.requireAttachable(authorId, requested) : [];

    const row = await this.repo.createPost({
      authorId,
      text: input.text,
      mediaIds: input.mediaIds,
      media,
      replyToId: parent?.id ?? null,
    });
    const post = this.toPost(row);

    await this.emitSafe('posts.post.created', {
      postId: row.id,
      authorId,
      text: row.text,
      mediaIds: row.mediaIds,
      replyToId: row.replyToId,
      repostOfId: row.repostOfId,
      createdAt: row.createdAt.toISOString(),
    });
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

    await this.emitSafe('posts.post.deleted', {
      postId,
      authorId: callerId,
      deletedAt: deleted.deletedAt?.toISOString() ?? new Date().toISOString(),
    });
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

  /** Internal (reset job): wipe posts + interactions; reseed via seed script. */
  async reseed(): Promise<void> {
    await this.repo.truncate();
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
   */
  private async requireAttachable(authorId: string, mediaIds: string[]): Promise<MediaAsset[]> {
    const resolved = await this.media.resolveForAttach(authorId, mediaIds);
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
  ): Promise<void> {
    try {
      await this.events.emit(eventType, payload);
    } catch (err) {
      // The DB write already committed; a missed event degrades downstream
      // views until the nightly reset rather than failing the user's action.
      logger.error({ err, eventType }, 'event emission failed');
    }
  }
}
