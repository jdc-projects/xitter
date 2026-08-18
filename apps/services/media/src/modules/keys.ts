import { MEDIA_MAX_BYTES } from '@xitter/api-contracts';
import { payloadTooLarge, unsupportedMediaType } from '@xitter/service-kit';

/** Product allowlist (spec 03/05): png/jpeg/webp/gif only. */
export const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

const MIME_EXTENSIONS: Record<AllowedMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** Slot-creation limit decisions (spec 03): 415 for type, 413 for size. */
export function validateUploadRequest(mimeType: string, bytes: number): AllowedMimeType {
  if (!ALLOWED_MIME_TYPES.includes(mimeType as AllowedMimeType)) {
    throw unsupportedMediaType(
      `Images must be png, jpeg, webp or gif (got ${mimeType})`,
    );
  }
  if (bytes > MEDIA_MAX_BYTES) {
    throw payloadTooLarge(`Images are limited to 5MB (got ${formatBytes(bytes)})`);
  }
  return mimeType as AllowedMimeType;
}

/** Object keys follow the data-platform layout: {userId}/{mediaId}/{variant}.{ext}. */
export function originalObjectKey(
  ownerId: string,
  mediaId: string,
  mimeType: AllowedMimeType,
): string {
  return `${ownerId}/${mediaId}/original.${MIME_EXTENSIONS[mimeType]}`;
}

export function thumbObjectKey(
  ownerId: string,
  mediaId: string,
  mimeType: AllowedMimeType,
): string {
  return `${ownerId}/${mediaId}/thumb.${MIME_EXTENSIONS[mimeType]}`;
}

/** Public edge URL for an object (spec 05: bucket served at /media). */
export function mediaUrl(objectKey: string): string {
  return `/media/${objectKey}`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
