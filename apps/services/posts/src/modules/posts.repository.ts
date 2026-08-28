import { Inject, Injectable } from '@nestjs/common';
import type { InteractionKind, MediaAsset } from '@xitter/api-contracts';
import { encodeCursor, decodeCursor } from '@xitter/service-kit';
import type { PrismaClient, Prisma } from '../generated/prisma/client.js';

/** DI token for the service-owned Prisma client (tests provide their own). */
export const POSTS_PRISMA = 'POSTS_PRISMA';

export type PostsPrismaClient = PrismaClient & { $disconnect(): Promise<void> };

export type PostRow = Prisma.PostGetPayload<Record<string, never>>;

export type PostsDb = Pick<PrismaClient, 'post' | 'interaction' | 'auditLog' | '$transaction'>;
export type InteractionRow = Prisma.InteractionGetPayload<Record<string, never>>;

export interface AuditRowInput {
  actorId: string;
  actorName: string;
  action: string;
  targetId: string;
  detail?: Record<string, unknown> | null;
}

type AuditRow = Prisma.AuditLogGetPayload<Record<string, never>>;

type PostPageOrder = 'newest-first' | 'oldest-first';

/**
 * Prisma data access for posts and interactions. Business rules (validation,
 * block enforcement, events) live in PostsService; this layer is queries only.
 */

/** Keyset scope: (createdAt, id) strictly after the cursor in page order. */
function scopedWhere(
  where: Prisma.PostWhereInput,
  position: { createdAt: string; id: string } | null,
  descending: boolean,
): Prisma.PostWhereInput {
  if (!position) return where;
  const boundary = new Date(position.createdAt);
  return {
    ...where,
    OR: [
      { createdAt: descending ? { lt: boundary } : { gt: boundary } },
      { createdAt: boundary, id: descending ? { lt: position.id } : { gt: position.id } },
    ],
  };
}

function orderByFor(descending: boolean): Prisma.PostOrderByWithRelationInput[] {
  const dir = descending ? 'desc' : 'asc';
  return [{ createdAt: dir }, { id: dir }];
}

/** Trim the over-fetch and emit the next cursor when a page continues. */
function pageResult(
  rows: PostRow[],
  limit: number,
): { items: PostRow[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
}

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
   * `createdAt` overrides the store's now-default for the seed's back-dated
   * corpus (#150); absent, the row stamps itself as usual.
   */
  createPost(input: {
    authorId: string;
    text: string;
    mediaIds: string[];
    media: MediaAsset[];
    replyToId: string | null;
    createdAt?: Date;
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
    const rows = await this.db.post.findMany({
      where: scopedWhere(where, position, descending),
      orderBy: orderByFor(descending),
      take: limit + 1,
    });
    return pageResult(rows, limit);
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
          data:
            input.kind === 'like'
              ? { likeCount: { increment: 1 } }
              : { repostCount: { increment: 1 } },
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

  // -- Admin moderation (T10) -------------------------------------------------

  /**
   * Moderation list: author/text/deleted filters, newest first, tombstones
   * included per the `deleted` tri-state (absent = both).
   */
  adminPosts(
    filters: { authorId?: string; text?: string; deleted?: 'true' | 'false' },
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: PostRow[]; nextCursor: string | null }> {
    const where: Prisma.PostWhereInput = {
      ...(filters.authorId ? { authorId: filters.authorId } : {}),
      ...(filters.text ? { text: { contains: filters.text, mode: 'insensitive' } } : {}),
      ...(filters.deleted === 'true'
        ? { deletedAt: { not: null } }
        : filters.deleted === 'false'
          ? { deletedAt: null }
          : {}),
    };
    return this.page(where, cursor, limit, 'newest-first');
  }

  /** Moderation soft delete + audit entry in one transaction. */
  adminSoftDelete(id: string, actor: AuditRowInput): Promise<PostRow | null> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.post.findFirst({ where: { id, deletedAt: null } });
      if (!existing) return null;
      const deleted = await tx.post.update({ where: { id }, data: { deletedAt: new Date() } });
      if (deleted.replyToId) {
        await tx.post
          .update({ where: { id: deleted.replyToId }, data: { replyCount: { decrement: 1 } } })
          .catch(() => undefined); // parent hard-deleted: counter is moot
      }
      await tx.auditLog.create({ data: { ...actor, targetId: id, detail: { hard: false } } });
      return deleted;
    });
  }

  /**
   * Hard delete: the row, its interactions, and - for replies - the parent's
   * counter go away; audit survives in the same transaction.
   */
  adminHardDelete(id: string, actor: AuditRowInput): Promise<PostRow | null> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.post.findUnique({ where: { id } });
      if (!existing) return null;
      if (existing.replyToId) {
        await tx.post
          .update({ where: { id: existing.replyToId }, data: { replyCount: { decrement: 1 } } })
          .catch(() => undefined);
      }
      await tx.interaction.deleteMany({ where: { postId: id } });
      await tx.post.delete({ where: { id } });
      await tx.auditLog.create({ data: { ...actor, targetId: id, detail: { hard: true } } });
      return existing;
    });
  }

  /** Moderation restore + audit entry; null when the post was not deleted. */
  adminRestore(id: string, actor: AuditRowInput): Promise<PostRow | null> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.post.findFirst({ where: { id, deletedAt: { not: null } } });
      if (!existing) return null;
      const restored = await tx.post.update({ where: { id }, data: { deletedAt: null } });
      if (restored.replyToId) {
        await tx.post
          .update({ where: { id: restored.replyToId }, data: { replyCount: { increment: 1 } } })
          .catch(() => undefined);
      }
      await tx.auditLog.create({ data: { ...actor, targetId: id, detail: { hard: false } } });
      return restored;
    });
  }

  /** Moderation audit trail, newest first. */
  async adminAudit(
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: AuditRow[]; nextCursor: string | null }> {
    const position = cursor ? decodeCursor(cursor) : null;
    const boundary = position ? new Date(position.createdAt) : null;
    const rows = await this.db.auditLog.findMany({
      where: boundary
        ? {
            OR: [
              { createdAt: { lt: boundary } },
              { createdAt: boundary, id: { lt: position!.id } },
            ],
          }
        : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  }

  toCounts(row: PostRow): { replies: number; likes: number; reposts: number } {
    return { replies: row.replyCount, likes: row.likeCount, reposts: row.repostCount };
  }
}
