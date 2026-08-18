import { ApiError } from '@xitter/api-client';
import type { InternalMediaAsset, MediaAsset, MediaVariantCore } from '@xitter/api-contracts';
import { EVENT_TYPES } from '@xitter/events';
import { createLogger } from '@xitter/observability';
import { deriveVariants } from './variants.js';

const logger = createLogger({ service: 'media-process-worker' });

/** What the worker needs from the media internal API (test seam). */
export interface MediaApi {
  internalGetAsset(mediaId: string): Promise<InternalMediaAsset>;
  internalRecordVariants(mediaId: string, variants: MediaVariantCore[]): Promise<MediaAsset>;
  internalReportFailure(mediaId: string, error: string): Promise<MediaAsset>;
}

/** What the worker needs from RustFS (test seam). */
export interface WorkerStorage {
  get(objectKey: string): Promise<Uint8Array>;
  put(objectKey: string, body: Uint8Array, contentType: string): Promise<void>;
}

export interface HandlerDeps {
  media: MediaApi;
  storage: WorkerStorage;
  /** Injectable so unit tests need no sharp buffers. */
  derive?: typeof deriveVariants;
}

/**
 * media.media.uploaded processing: fetch the original from RustFS, derive
 * the variant set (original metadata + generated thumb), upload the thumb,
 * and record the variants via the media internal API (which flips the asset
 * to ready and emits media.media.processed).
 *
 * At-least-once delivery rules (spec 04):
 * - redelivery of an already-processed asset is skipped (status check);
 * - a failed asset (attempt cap) is skipped so retries terminate;
 * - a processing error reports the failure; while the media service still
 *   reports `pending` the error is rethrown so Kafka redelivers.
 */
export async function handleEvent(envelope: unknown, deps: HandlerDeps): Promise<void> {
  const { eventType, payload } = (envelope ?? {}) as {
    eventType?: string;
    payload?: Record<string, unknown>;
  };
  if (eventType !== EVENT_TYPES.mediaUploaded) return;

  const mediaId = typeof payload?.mediaId === 'string' ? payload.mediaId : null;
  if (!mediaId) {
    logger.warn({ eventType }, 'media.uploaded event without mediaId - skipping');
    return;
  }

  const asset = await deps.media.internalGetAsset(mediaId).catch((err: unknown) => {
    // Deleted between emission and consumption (e.g. the reset raced us):
    // nothing to process, and throwing would hot-loop a 404. Any other
    // failure (media down mid-deploy, token fetch error) must redeliver -
    // skipping here would strand the asset in pending forever.
    if (err instanceof ApiError && err.status === 404) {
      logger.warn({ mediaId }, 'asset vanished - skipping event');
      return null;
    }
    throw err;
  });
  if (!asset || asset.status !== 'pending') return; // ready (redelivery) or failed (cap)

  try {
    const original = await deps.storage.get(asset.objectKey);
    const { variants, thumbBytes } = await (deps.derive ?? deriveVariants)(original, {
      objectKey: asset.objectKey,
      mimeType: asset.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
    });
    const thumb = variants.find((variant) => variant.kind === 'thumb');
    if (thumb) {
      await deps.storage.put(thumb.objectKey, thumbBytes, thumb.mimeType);
    }
    await deps.media.internalRecordVariants(mediaId, variants);
    logger.info({ mediaId }, 'media processed');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reported = await deps.media
      .internalReportFailure(mediaId, message)
      .catch((reportErr: unknown) => {
        // The failure report itself failed (media down): rethrow the
        // original error so the attempt redelivers whole - attempt
        // accounting must never be silently lost.
        logger.error({ err: reportErr, mediaId }, 'failure report failed');
        throw err;
      });
    if (reported.status === 'failed') {
      // Cap reached: swallow so the offset commits (the status check above
      // would skip this asset on later redeliveries anyway).
      logger.warn({ mediaId, message }, 'media processing failed permanently');
      return;
    }
    throw err; // still pending - let Kafka redeliver
  }
}
