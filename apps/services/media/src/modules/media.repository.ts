import { Inject, Injectable } from '@nestjs/common';
import { encodeCursor, decodeCursor } from '@xitter/service-kit';
import type { PrismaClient, Prisma } from '../generated/prisma/client.js';

/** DI token for the service-owned Prisma client (tests provide their own). */
export const MEDIA_PRISMA = 'MEDIA_PRISMA';

export type MediaPrismaClient = PrismaClient & { $disconnect(): Promise<void> };

export type MediaRow = Prisma.MediaAssetGetPayload<Record<string, never>>;

export type AuditRow = Prisma.AuditLogGetPayload<Record<string, never>>;

export type MediaVariantRecord = {
  kind: 'original' | 'thumb';
  objectKey: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
};

export type MediaDb = Pick<PrismaClient, 'mediaAsset' | 'auditLog' | '$transaction'>;

export interface AuditRowInput {
  actorId: string;
  actorName: string;
  action: string;
  targetId: string;
  detail?: Record<string, unknown> | null;
}

/**
 * Prisma data access for media assets. Lifecycle rules (upload limits,
 * event emission) live in MediaService; this layer is queries only.
 */
@Injectable()
export class MediaRepository {
  constructor(@Inject(MEDIA_PRISMA) private readonly db: MediaDb) {}

  find(mediaId: string): Promise<MediaRow | null> {
    return this.db.mediaAsset.findUnique({ where: { id: mediaId } });
  }

  findByIds(mediaIds: string[]): Promise<MediaRow[]> {
    return this.db.mediaAsset.findMany({ where: { id: { in: mediaIds } } });
  }

  /**
   * Internal (posts, #133): persist author-supplied alt text onto assets.
   * Callers resolve ownership first and only pass ids that were just read,
   * so every update targets an existing row (a miss would throw P2025 and
   * fail the lookup loudly rather than silently dropping the text).
   */
  applyAltTexts(altTexts: Record<string, string>): Promise<MediaRow[]> {
    const entries = Object.entries(altTexts);
    if (entries.length === 0) return Promise.resolve([]);
    return this.db.$transaction(
      entries.map(([id, altText]) =>
        this.db.mediaAsset.update({ where: { id }, data: { altText } }),
      ),
    );
  }

  create(input: {
    id: string;
    ownerId: string;
    objectKey: string;
    mimeType: string;
    bytes: number;
  }): Promise<MediaRow> {
    return this.db.mediaAsset.create({
      data: { ...input, status: 'pending', variants: [] },
    });
  }

  markUploaded(id: string, bytes: number): Promise<MediaRow> {
    return this.db.mediaAsset.update({
      where: { id },
      data: { uploadedAt: new Date(), bytes },
    });
  }

  markFailed(id: string): Promise<MediaRow> {
    return this.db.mediaAsset.update({ where: { id }, data: { status: 'failed' } });
  }

  recordVariants(id: string, variants: MediaVariantRecord[]): Promise<MediaRow> {
    return this.db.mediaAsset.update({ where: { id }, data: { status: 'ready', variants } });
  }

  /** Internal (worker): bump the attempt counter; failed once the cap hits. */
  recordAttempt(id: string, failed: boolean): Promise<MediaRow> {
    return this.db.mediaAsset.update({
      where: { id },
      data: { attempts: { increment: 1 }, ...(failed ? { status: 'failed' } : {}) },
    });
  }

  /** Nightly reset: metadata goes away (reset job owns bucket contents). */
  truncate(): Promise<unknown> {
    return this.db.mediaAsset.deleteMany();
  }

  // -- Admin moderation (T10) -------------------------------------------------

  /**
   * Moderation list, newest first. Keyset page on (createdAt, id) - same
   * cursor contract as the public pages.
   */
  async adminMedia(
    filters: { ownerId?: string; status?: 'pending' | 'ready' | 'failed' },
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: MediaRow[]; nextCursor: string | null }> {
    const position = cursor ? decodeCursor(cursor) : null;
    const boundary = position ? new Date(position.createdAt) : null;
    const rows = await this.db.mediaAsset.findMany({
      where: {
        ...(filters.ownerId ? { ownerId: filters.ownerId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
        ...(boundary
          ? {
              OR: [
                { createdAt: { lt: boundary } },
                { createdAt: boundary, id: { lt: position!.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.at(-1);
    return { items, nextCursor: hasMore && last ? encodeCursor(last) : null };
  }

  /**
   * Moderation delete: the row and the audit entry go in one transaction;
   * object removal happens after commit (best-effort, like rejected uploads
   * - a leaked object in a public bucket is the smaller failure vs losing
   * the moderation record).
   */
  adminDelete(id: string, actor: AuditRowInput): Promise<MediaRow | null> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.mediaAsset.findUnique({ where: { id } });
      if (!existing) return null;
      await tx.mediaAsset.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          actorId: actor.actorId,
          actorName: actor.actorName,
          action: actor.action,
          targetId: actor.targetId,
        },
      });
      return existing;
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
}
