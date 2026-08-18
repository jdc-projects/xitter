import { Inject, Injectable } from '@nestjs/common';
import type { PrismaClient, Prisma } from '../generated/prisma/client.js';

/** DI token for the service-owned Prisma client (tests provide their own). */
export const MEDIA_PRISMA = 'MEDIA_PRISMA';

export type MediaPrismaClient = PrismaClient & { $disconnect(): Promise<void> };

export type MediaRow = Prisma.MediaAssetGetPayload<Record<string, never>>;

export type MediaVariantRecord = {
  kind: 'original' | 'thumb';
  objectKey: string;
  mimeType: string;
  bytes: number;
  width: number | null;
  height: number | null;
};

export type MediaDb = Pick<PrismaClient, 'mediaAsset'>;

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
}
