import { Inject, Injectable } from '@nestjs/common';
import type { MediaAsset } from '@xitter/api-contracts';
import { encodeCursor, decodeCursor } from '@xitter/service-kit';
import type { PrismaClient, Prisma } from '../generated/prisma/client.js';

/** DI token for the service-owned Prisma client (tests provide their own). */
export const POSTS_PRISMA = 'POSTS_PRISMA';

export type PostsPrismaClient = PrismaClient & { $disconnect(): Promise<void> };

export type PostRow = Prisma.PostGetPayload<Record<string, never>>;

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

  toCounts(row: PostRow): { replies: number; likes: number; reposts: number } {
    return { replies: row.replyCount, likes: row.likeCount, reposts: row.repostCount };
  }
}
