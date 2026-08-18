import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { deriveVariants, THUMB_MAX_DIMENSION } from './variants.js';

/** Solid PNG test image at an arbitrary size. */
async function png(width: number, height: number): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({
      create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .png()
      .toBuffer(),
  );
}

const ASSET = {
  objectKey:
    '00000000-0000-4000-8000-0000000000a1/00000000-0000-4000-8000-0000000000b2/original.png',
  mimeType: 'image/png' as const,
};

describe('deriveVariants', () => {
  it('records the untouched original plus a bounded thumb', async () => {
    const original = await png(1280, 800);
    const { variants, thumbBytes } = await deriveVariants(original, ASSET);

    expect(variants).toEqual([
      {
        kind: 'original',
        objectKey: ASSET.objectKey,
        mimeType: 'image/png',
        bytes: original.byteLength,
        width: 1280,
        height: 800,
      },
      {
        kind: 'thumb',
        objectKey: ASSET.objectKey.replace('original.png', 'thumb.png'),
        mimeType: 'image/png',
        bytes: thumbBytes.byteLength,
        // Fits inside the box, aspect preserved, no enlargement.
        width: THUMB_MAX_DIMENSION,
        height: 200,
      },
    ]);
    // The thumb is a real, decodable image of the derived size.
    const meta = await sharp(Buffer.from(thumbBytes)).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(THUMB_MAX_DIMENSION);
  });

  it('keeps same-format outputs for webp and gif sources', async () => {
    const webpKey = ASSET.objectKey.replace('original.png', 'original.webp');
    const webp = new Uint8Array(
      await sharp({ create: { width: 64, height: 64, channels: 3, background: 'red' } })
        .webp()
        .toBuffer(),
    );
    const { variants } = await deriveVariants(webp, { objectKey: webpKey, mimeType: 'image/webp' });
    expect(variants.every((variant) => variant.mimeType === 'image/webp')).toBe(true);
    expect(variants[1]!.objectKey).toContain('thumb.webp');

    const gifKey = ASSET.objectKey.replace('original.png', 'original.gif');
    const gif = new Uint8Array(
      await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } })
        .gif()
        .toBuffer(),
    );
    const gifResult = await deriveVariants(gif, { objectKey: gifKey, mimeType: 'image/gif' });
    expect(gifResult.variants[1]!.objectKey).toContain('thumb.gif');
  });

  it('never enlarges small originals', async () => {
    const tiny = await png(64, 32);
    const { variants } = await deriveVariants(tiny, ASSET);
    expect(variants[1]).toMatchObject({ width: 64, height: 32 });
  });

  it('rejects non-image bytes (failOn default) - spoofed content dies here', async () => {
    const html = new TextEncoder().encode('<script>alert(1)</script>');
    await expect(deriveVariants(html, ASSET)).rejects.toThrow();
  });
});
