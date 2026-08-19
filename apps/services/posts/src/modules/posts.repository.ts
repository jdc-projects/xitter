import { Inject, Injectable } from '@nestjs/common';
import type { InteractionKind, MediaAsset, Post } from '@xitter/api-contracts';
import { encodeCursor, decodeCursor } from '@xitter/service-kit';
import type { PrismaClient, Prisma } from '../generated/prisma/client.js';

/** DI token for the service-owned Prisma client (tests provide their own). */
export const POSTS_PRISMA = 'POSTS_PRISMA';

export type PostsPrismaClient = PrismaClient & { $disconnect(): Promise<void> };

export type PostRow = Prisma.PostGetPayload<Record<string, never>>;

export type InteractionRow = Prisma.InteractionGetPayload<Record<string, never>>;

export type PostsDb = Pick<PrismaClient, 'post' | 'interaction' | '$transaction'>;

type PostPageOrder = 'newest-first' | 'oldest-first';

/**
 * Prisma data access for posts and interactions. Business rules (validation,
 * block enforcement, events) live in PostsService; this layer is queries only.
 */
@Injectable()
export class PostsRepository {
  constructor(@Inject(POSTS_PRISMA) private readonly db: PostsDb) {}

  findPost(id: string): Promise<PostRow | null> {
    return this.db.post.findUnique({ where: { id } });
  }

  /** Visible = not soft-deleted; deleted posts are hidden everywhere. */
  findVisiblePost(id: string): Promise<PostRow | null> {
    return this.db.post.findFirst({ where: { id, deletedAt: null } });
  }

  /** Bulk visible-post lookup (internal hydration; order not guaranteed). */
  visiblePosts(ids: string[]): Promise<PostRow[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db.post.findMany({ where: { id: { in: ids }, deletedAt: null } });
  }

  /**
   * Create a post and, for replies, bump the parent's reply counter in one
   * transaction so the counts read-model can never drift from the rows.
   */
  createPost(input: {
    authorId: string;
    text: string;
    mediaIds: string[];
    media: MediaAsset[];
    replyToId: string | null;
  }): Promise<PostRow> {
    return this.db.$transaction(async (tx) => {
      const post = await tx.post.create({ data: input });
      if (input.replyToId) {
        await tx.post.update({
          where: { id: input.replyToId },
          data: { replyCount: { increment: 1 } },
        });
      }
      return post;
    });
  }

  /**
   * Soft delete; returns the previous row when a live post was actually
   * removed (already-deleted posts are a no-op), so events fire once.
   * Deleting a reply decrements its parent's reply counter.
   */
  softDelete(id: string): Promise<PostRow | null> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.post.findFirst({ where: { id, deletedAt: null } });
      if (!existing) return null;
      const deleted = await tx.post.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      if (deleted.replyToId) {
        await tx.post
          .update({
            where: { id: deleted.replyToId },
            data: { replyCount: { decrement: 1 } },
          })
          .catch(() => undefined); // parent hard-deleted row: counter is moot
      }
      return deleted;
    });
  }

  /**
   * Keyset page over an author's visible posts, newest first (spec 03).
   * Replies are included: the profile tab is the author's full post list.
   */
  authorPosts(
    authorId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: PostRow[]; nextCursor: string | null }> {
    return this.page({ authorId, deletedAt: null }, cursor, limit, 'newest-first');
  }

  /**
   * Keyset page over a post's visible replies, oldest first (chronological
   * thread order, spec 03).
   */
  replies(
    postId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: PostRow[]; nextCursor: string | null }> {
    return this.page({ replyToId: postId, deletedAt: null }, cursor, limit, 'oldest-first');
  }

  private async page(
    where: Prisma.PostWhereInput,
    cursor: string | undefined,
    limit: number,
    order: PostPageOrder,
  ): Promise<{ items: PostRow[]; nextCursor: string | null }> {
    const position = cursor ? decodeCursor(cursor) : null;
    const descending = order === 'newest-first';
    const boundary = position ? new Date(position.createdAt) : null;
    const scoped: Prisma.PostWhereInput = boundary
      ? {
          ...where,
          OR: [
            { createdAt: descending ? { lt: boundary } : { gt: boundary } },
            { createdAt: boundary, id: descending ? { lt: position!.id } : { gt: position!.id } },
          ],
        }
      : where;
    const orderBy: Prisma.PostOrderByWithRelationInput[] = [
      { createdAt: descending ? 'desc' : 'asc' },
      { id: descending ? 'desc' : 'asc' },
    ];

    const rows = await this.db.post.findMany({
      where: scoped,
      orderBy,
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  }

  /** Nightly reset: posts and interactions go away together (reset job only). */
  async truncate(): Promise<void> {
    await this.db.interaction.deleteMany();
    await this.db.post.deleteMany();
  }

  /**
   * Idempotent interaction create + count bump in ONE transaction (spec
   * data/01: the counts read-model never drifts from the rows). The natural
   * key (kind, postId, userId) absorbs concurrent duplicate creates; the
   * counter only moves when a row actually lands. Returns the row and
   * whether it was newly created (repeat creates resolve to the stored row
   * without re-emitting lifecycle effects).
   */
  createInteraction(input: {
    kind: InteractionKind;
    postId: string;
    userId: string;
  }): Promise<{ row: InteractionRow; created: boolean }> {
    return this.db.$transaction(async (tx) => {
      const inserted = await tx.interaction.createMany({
        data: input,
        skipDuplicates: true,
      });
      const row = await tx.interaction.findUniqueOrThrow({
        where: { kind_postId_userId: input },
      });
      if (inserted.count === 0) return { row, created: false };

      // Bookmarks are private annotations - no public count to maintain.
      if (input.kind === 'like' || input.kind === 'repost') {
        await tx.post.update({
          where: { id: input.postId },
          data: input.kind === 'like' ? { likeCount: { increment: 1 } } : { repostCount: { increment: 1 } },
        });
      }
      return { row, created: true };
    });
  }

  /**
   * Undo: removes the row and reverses the counter only when a row was
   * actually removed (idempotent deletes). Returns false when nothing
   * existed - the service still answers 204.
   */
  deleteInteraction(input: {
    kind: InteractionKind;
    postId: string;
    userId: string;
  }): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const removed = await tx.interaction.deleteMany({ where: input });
      if (removed.count === 0) return false;

      if (input.kind === 'like' || input.kind === 'repost') {
        await tx.post
          .update({
            where: { id: input.postId },
            data:
              input.kind === 'like'
                ? { likeCount: { decrement: 1 } }
                : { repostCount: { decrement: 1 } },
          })
          .catch(() => undefined); // hard-deleted parent row: counter is moot
      }
      return true;
    });
  }

  /**
   * The caller's bookmark list, newest bookmark first. Soft-deleted posts
   * drop out here (not at hydration) so bookmarks never resurrect tombstones.
   * The cursor is the interaction row's keyset position.
   */
  async bookmarks(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: PostRow[]; nextCursor: string | null }> {
    const position = cursor ? decodeCursor(cursor) : null;
    const boundary = position ? new Date(position.createdAt) : null;
    const where: Prisma.InteractionWhereInput = {
      kind: 'bookmark',
      userId,
      post: { deletedAt: null },
      ...(boundary
        ? {
            OR: [
              { createdAt: { lt: boundary } },
              { createdAt: boundary, id: { lt: position!.id } },
            ],
          }
        : {}),
    };

    const rows = await this.db.interaction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: { post: true },
    });

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return {
      items: items.map((row) => row.post),
      nextCursor: hasMore && last ? encodeCursor(last) : null,
    };
  }

  /** The user's interaction rows for a batch of posts (viewer-state input). */
  interactionsForPosts(
    userId: string,
    postIds: string[],
  ): Promise<Pick<InteractionRow, 'kind' | 'postId'>[]> {
    if (postIds.length === 0) return Promise.resolve([]);
    return this.db.interaction.findMany({
      where: { userId, postId: { in: postIds } },
      select: { kind: true, postId: true },
    });
  }

  toCounts(row: PostRow): { replies: number; likes: number; reposts: number } {
    return { replies: row.replyCount, likes: row.likeCount, reposts: row.repostCount };
  }
}
