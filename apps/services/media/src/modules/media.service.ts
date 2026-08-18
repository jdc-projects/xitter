import { Inject, Injectable } from '@nestjs/common';
import {
  MEDIA_MAX_BYTES,
  type CreateMediaUploadResponse,
  type InternalMediaAsset,
  type MediaAsset,
  type MediaVariantCore,
} from '@xitter/api-contracts';
import { createLogger } from '@xitter/observability';
import { badRequest, notFound } from '@xitter/service-kit';
import { MEDIA_EVENTS, type MediaEvents } from './media-events.js';
import { MediaRepository, type MediaRow, type MediaVariantRecord } from './media.repository.js';
import { MEDIA_STORAGE, type MediaStorage } from './storage.js';
import {
  mediaUrl,
  originalObjectKey,
  validateUploadRequest,
  ALLOWED_MIME_TYPES,
  type AllowedMimeType,
} from './keys.js';

const logger = createLogger({ service: 'media' });

/** Worker processing attempts before an asset is marked failed (spec: no infinite retry). */
export const MAX_PROCESS_ATTEMPTS = 3;

/**
 * Image upload lifecycle (spec 03 / data 03): slot → browser PUT → complete
 * (HEAD-verified) → `media.media.uploaded` → worker variants → ready.
 *
 * - limits (mime allowlist, 5MB) are enforced at slot creation and re-checked
 *   against the object's real size at completion - the client's `bytes` claim
 *   is never trusted;
 * - `complete` HEADs the exact key before any event is emitted;
 * - duplicate `complete` calls are idempotent (one uploaded event per asset);
 * - events are best-effort after commit, like posts.
 */
@Injectable()
export class MediaService {
  constructor(
    private readonly repo: MediaRepository,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    @Inject(MEDIA_EVENTS) private readonly events: MediaEvents,
  ) {}

  async createUpload(
    ownerId: string,
    input: { mimeType: string; bytes: number },
  ): Promise<CreateMediaUploadResponse> {
    const mimeType = validateUploadRequest(input.mimeType, input.bytes);
    const mediaId = crypto.randomUUID();
    const objectKey = originalObjectKey(ownerId, mediaId, mimeType);
    await this.repo.create({
      id: mediaId,
      ownerId,
      objectKey,
      mimeType,
      bytes: input.bytes,
    });
    const uploadUrl = await this.storage.presignPut(objectKey, mimeType);
    return { mediaId, uploadUrl };
  }

  /**
   * Client callback after the browser PUT. Server-side verification: the
   * object must exist at the exact key, and its real size must respect the
   * 5MB cap, before `media.media.uploaded` is emitted.
   */
  async complete(ownerId: string, mediaId: string): Promise<MediaAsset> {
    const row = await this.requireOwned(ownerId, mediaId);
    if (row.status === 'failed') {
      throw badRequest('This image failed processing and cannot be completed');
    }

    const stat = await this.storage.head(row.objectKey);
    if (!stat) {
      throw badRequest('Upload not found yet - the image may still be uploading');
    }
    // Presigned PUTs sign only the host, so the STORED content type is the
    // client's claim; the allowlist is re-checked here (the bucket is public
    // - a text/html object would be a same-origin script vector).
    if (!stat.contentType || !ALLOWED_MIME_TYPES.includes(stat.contentType as AllowedMimeType)) {
      await this.rejectUpload(mediaId, row.objectKey);
      throw badRequest('Uploaded object is not an allowed image type');
    }
    if (stat.bytes <= 0) {
      await this.rejectUpload(mediaId, row.objectKey);
      throw badRequest('Uploaded image is empty');
    }
    if (stat.bytes > MEDIA_MAX_BYTES) {
      await this.rejectUpload(mediaId, row.objectKey);
      throw badRequest('Uploaded image exceeds the 5MB limit');
    }

    // Idempotent: a repeat complete (client retry) must not re-emit.
    if (row.uploadedAt) return this.toAsset(row);

    const updated = await this.repo.markUploaded(mediaId, stat.bytes);
    await this.emitSafe('media.media.uploaded', {
      mediaId,
      ownerId,
      objectKey: row.objectKey,
      mimeType: row.mimeType,
      bytes: stat.bytes,
      createdAt: updated.createdAt.toISOString(),
    });
    return this.toAsset(updated);
  }

  /** Media metadata incl. variant URLs (rendering + upload polling). */
  async getMedia(mediaId: string): Promise<MediaAsset> {
    const row = await this.repo.find(mediaId);
    if (!row) throw notFound('Media not found');
    return this.toAsset(row);
  }

  /** Internal (workers): asset incl. storage coordinates + attempt count. */
  async getInternal(mediaId: string): Promise<InternalMediaAsset> {
    const row = await this.repo.find(mediaId);
    if (!row) throw notFound('Media not found');
    return {
      ...this.toAsset(row),
      objectKey: row.objectKey,
      mimeType: row.mimeType,
      bytes: row.bytes,
      attempts: row.attempts,
    };
  }

  /** Internal (posts): existence + ownership + ready-status resolution. */
  async lookup(ownerId: string, mediaIds: string[]): Promise<MediaAsset[]> {
    const rows = await this.repo.findByIds(mediaIds);
    return rows.filter((row) => row.ownerId === ownerId).map((row) => this.toAsset(row));
  }

  /**
   * Internal (media-process worker): record variants and flip to ready.
   * Idempotent on redelivery - an already-ready asset is returned untouched
   * and `media.media.processed` is not re-emitted.
   */
  async recordVariants(mediaId: string, variants: MediaVariantCore[]): Promise<MediaAsset> {
    const row = await this.requireExisting(mediaId);
    if (row.status === 'ready') return this.toAsset(row);

    const updated = await this.repo.recordVariants(mediaId, variants);
    await this.emitSafe('media.media.processed', {
      mediaId,
      ownerId: updated.ownerId,
      variants,
      processedAt: new Date().toISOString(),
    });
    return this.toAsset(updated);
  }

  /**
   * Internal (worker): a processing attempt failed. The service owns the
   * attempt counter; the response tells the worker whether to let Kafka
   * redeliver (still pending) or stop (failed).
   */
  async reportFailure(mediaId: string, _error: string): Promise<MediaAsset> {
    const row = await this.requireExisting(mediaId);
    const failed = row.attempts + 1 >= MAX_PROCESS_ATTEMPTS;
    const updated = await this.repo.recordAttempt(mediaId, failed);
    if (failed) {
      // Same rationale as rejectUpload: the bucket is public and the asset
      // is dead (likely corrupt or hostile content sharp cannot decode) -
      // the object must not stay served until the nightly wipe.
      await this.storage.remove(row.objectKey).catch((err) => {
        logger.warn({ err, objectKey: row.objectKey }, 'failed-asset object cleanup failed');
      });
    }
    return this.toAsset(updated);
  }

  /** Internal (reset job): wipe metadata; bucket contents are the reset's. */
  async reseed(): Promise<void> {
    await this.repo.truncate();
  }

  /** A rejected upload is failed AND its object is removed (public bucket). */
  private async rejectUpload(mediaId: string, objectKey: string): Promise<void> {
    await this.repo.markFailed(mediaId);
    await this.storage.remove(objectKey).catch((err) => {
      logger.warn({ err, objectKey }, 'rejected-upload object cleanup failed');
    });
  }

  private async requireExisting(mediaId: string): Promise<MediaRow> {
    const row = await this.repo.find(mediaId);
    if (!row) throw notFound('Media not found');
    return row;
  }

  private async requireOwned(ownerId: string, mediaId: string): Promise<MediaRow> {
    const row = await this.requireExisting(mediaId);
    if (row.ownerId !== ownerId) {
      // Indistinguishable from missing: media ids are not enumerable.
      throw notFound('Media not found');
    }
    return row;
  }

  private toAsset(row: MediaRow): MediaAsset {
    return {
      id: row.id,
      ownerId: row.ownerId,
      status: row.status as MediaAsset['status'],
      variants: ((row.variants ?? []) as MediaVariantRecord[]).map((variant) => ({
        ...variant,
        url: mediaUrl(variant.objectKey),
      })),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async emitSafe(
    eventType: Parameters<MediaEvents['emit']>[0],
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.events.emit(eventType, payload);
    } catch (err) {
      // The DB write already committed; a missed event stalls this asset in
      // pending until the nightly reset rather than failing the user's call.
      logger.error({ err, eventType }, 'event emission failed');
    }
  }
}
