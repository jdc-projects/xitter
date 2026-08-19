import sharp from 'sharp';
import type { MediaVariantCore } from '@xitter/api-contracts';

/** Thumbs fit inside this box (product: card-rendered previews). */
export const THUMB_MAX_DIMENSION = 320;

/** Output format per allowed mime (sharp format names align with mimes). */
const FORMATS = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
  'image/gif': 'gif',
} as const;

export type DeriveInput = {
  objectKey: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
};

export interface DerivedVariants {
  /** Variant records to hand to the media internal API. */
  variants: MediaVariantCore[];
  /** Generated thumb bytes (the original's bytes are already in RustFS). */
  thumbBytes: Uint8Array;
}

/**
 * Derive the variant set from the uploaded original: `original` (the stored
 * bytes, untouched - metadata only, per spec 05) + `thumb` (auto-oriented,
 * resized to fit 320px, same mime; gifs keep their animation). Regeneration
 * is deterministic - same input bytes, same keys and output - so redelivery
 * overwrites cleanly (spec 04 idempotency rule 2).
 */
export async function deriveVariants(
  original: Uint8Array,
  asset: DeriveInput,
): Promise<DerivedVariants> {
  const animated = asset.mimeType === 'image/gif';
  // failOn:'error' (sharp default) rejects non-image bytes: a renamed html
  // file with an image content type dies here, not in feeds.
  const base = sharp(Buffer.from(original), { animated });

  const thumbKey = asset.objectKey.replace(/original\.([a-z]+)$/, 'thumb.$1');
  const { data: thumb, info } = await base
    .clone()
    .rotate() // EXIF auto-orient before resizing
    .resize({
      width: THUMB_MAX_DIMENSION,
      height: THUMB_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toFormat(FORMATS[asset.mimeType])
    .toBuffer({ resolveWithObject: true });

  const meta = await base.metadata();

  return {
    variants: [
      {
        kind: 'original',
        objectKey: asset.objectKey,
        mimeType: asset.mimeType,
        bytes: original.byteLength,
        width: meta.width ?? null,
        height: meta.height ?? null,
      },
      {
        kind: 'thumb',
        objectKey: thumbKey,
        mimeType: asset.mimeType,
        bytes: thumb.byteLength,
        width: info.width ?? null,
        height: info.height ?? null,
      },
    ],
    thumbBytes: new Uint8Array(thumb),
  };
}
