import { describe, expect, it } from 'vitest';
import type { MediaAsset, Post } from '@xitter/api-contracts';
import { GENERIC_IMAGE_ALT, imagesFor } from './images';

const asset = (overrides: Partial<MediaAsset>): MediaAsset => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  ownerId: '00000000-0000-4000-8000-0000000000a1',
  status: 'ready',
  variants: [
    {
      kind: 'thumb',
      objectKey: 'o/1/thumb.png',
      mimeType: 'image/png',
      bytes: 100,
      width: 10,
      height: 10,
      url: '/media/o/1/thumb.png',
    },
    {
      kind: 'original',
      objectKey: 'o/1/original.png',
      mimeType: 'image/png',
      bytes: 1000,
      width: 100,
      height: 100,
      url: '/media/o/1/original.png',
    },
  ],
  createdAt: '2026-08-18T00:00:00.000Z',
  ...overrides,
});

const post = (media: MediaAsset[]): Pick<Post, 'media'> => ({ media });

describe('imagesFor alt text (#133)', () => {
  it('renders the stored alt text for assets that carry one', () => {
    const images = imagesFor(post([asset({ altText: 'A red kite over a grey pier' })]), 'thumb');
    expect(images).toEqual([{ url: '/media/o/1/thumb.png', alt: 'A red kite over a grey pier' }]);
  });

  it('falls back to the generic string for legacy snapshots (field absent)', () => {
    const images = imagesFor(post([asset({})]), 'thumb');
    expect(images[0]?.alt).toBe(GENERIC_IMAGE_ALT);
  });

  it('falls back for null and whitespace-only alt text', () => {
    expect(imagesFor(post([asset({ altText: null })]), 'thumb')[0]?.alt).toBe(GENERIC_IMAGE_ALT);
    expect(imagesFor(post([asset({ altText: '   ' })]), 'thumb')[0]?.alt).toBe(GENERIC_IMAGE_ALT);
  });

  it('still picks the requested variant and trims surrounding whitespace', () => {
    const detail = imagesFor(post([asset({ altText: '  kite  ' })]), 'original');
    expect(detail).toEqual([{ url: '/media/o/1/original.png', alt: 'kite' }]);
  });
});
