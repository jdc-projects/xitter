import type { PostCardImage } from '@xitter/ui';
import type { Post } from '@xitter/api-contracts';

/**
 * Chosen-variant images from a post's media snapshot: lists render thumbs,
 * the detail page originals. Falls back to the first variant when the
 * requested one is missing (can't happen today - both are always recorded).
 */
export function imagesFor(
  post: Pick<Post, 'media'>,
  variant: 'thumb' | 'original',
): PostCardImage[] {
  return post.media.flatMap((asset) => {
    const chosen = asset.variants.find((item) => item.kind === variant) ?? asset.variants[0];
    return chosen ? [{ url: chosen.url, alt: 'Image attached to post' }] : [];
  });
}
