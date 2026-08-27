import type { PostCardImage } from '@xitter/ui';
import type { Post } from '@xitter/api-contracts';

/** Rendered when an asset carries no alt text (legacy snapshots, #133). */
export const GENERIC_IMAGE_ALT = 'Image attached to post';

/**
 * Chosen-variant images from a post's media snapshot: lists render thumbs,
 * the detail page originals. Falls back to the first variant when the
 * requested one is missing (can't happen today - both are always recorded).
 * Alt text comes from the author when present (#133); assets without one
 * (legacy snapshots, alt-less attachments) fall back to the generic string.
 */
export function imagesFor(
  post: Pick<Post, 'media'>,
  variant: 'thumb' | 'original',
): PostCardImage[] {
  return post.media.flatMap((asset) => {
    const chosen = asset.variants.find((item) => item.kind === variant) ?? asset.variants[0];
    const alt = asset.altText?.trim() || GENERIC_IMAGE_ALT;
    return chosen ? [{ url: chosen.url, alt }] : [];
  });
}
