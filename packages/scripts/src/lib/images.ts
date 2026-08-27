import { deflateSync } from 'node:zlib';

/**
 * Deterministic demo images for the seed corpus: a tiny valid PNG derived
 * from a seeded PRNG (no faker - keeps the corpus RNG sequence untouched).
 * Bytes are pure functions of (seed, spec), so every environment uploads
 * identical objects through the real media pipeline.
 *
 * #150 widens the palette: several patterns (gradient directions, stripes)
 * and several aspect/size combinations, so the seeded feed shows more than
 * one grey-ish rectangle. The pattern ids and their human descriptions are
 * the alt-text source of truth (#133) - the corpus describes what this
 * module renders, never the other way round.
 */

/** mulberry32 - small, fast, fully deterministic. Exported for the corpus's slot-hash streams. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type DemoImagePatternId = 'gradient-h' | 'gradient-v' | 'gradient-diagonal' | 'stripes';

export interface DemoImagePattern {
  id: DemoImagePatternId;
  /** Honest description rendered into the corpus alt text (#133). */
  description: string;
}

/** The pattern palette; array order is part of the corpus derivation. */
export const DEMO_IMAGE_PATTERNS: readonly DemoImagePattern[] = [
  { id: 'gradient-h', description: 'a left-to-right color gradient with fine noise' },
  { id: 'gradient-v', description: 'a top-to-bottom color gradient with fine noise' },
  { id: 'gradient-diagonal', description: 'a diagonal color gradient with fine noise' },
  { id: 'stripes', description: 'vertical stripes of two hues with fine noise' },
];

/** Size/aspect palette (width, height) - small, varied, all well under the caps. */
export const DEMO_IMAGE_SIZES: readonly (readonly [number, number])[] = [
  [96, 64],
  [64, 96],
  [128, 96],
  [96, 128],
  [160, 120],
  [120, 160],
  [112, 112],
  [176, 99],
];

export interface DemoImageSpec {
  pattern: DemoImagePatternId;
  width: number;
  height: number;
}

/** The historical single look (kept as the default for bare `demoPng(seed)` calls). */
const DEFAULT_DEMO_IMAGE_SPEC: DemoImageSpec = {
  pattern: 'gradient-h',
  width: 96,
  height: 64,
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Table-driven CRC32 (PNG chunks). */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * RGB PNG (color type 2, 8-bit): a seeded gradient/stripes pattern + noise.
 * Pure function of (seed, spec) - identical bytes in every environment.
 */
export function demoPng(seed: number, spec: DemoImageSpec = DEFAULT_DEMO_IMAGE_SPEC): Buffer {
  const { width, height } = spec;
  const random = mulberry32(seed);
  const baseHue = random() * 360;
  const [r0, g0, b0] = hslToRgb(baseHue, 0.65, 0.45);
  const [r1, g1, b1] = hslToRgb((baseHue + 80) % 360, 0.6, 0.62);

  // Raw scanlines: one filter byte (0 = None) + RGB triplets.
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      // Pattern position: where this pixel sits on the two-hue blend.
      const t = patternPosition(spec.pattern, x, y, width, height);
      const jitter = Math.floor(random() * 24) - 12;
      const at = row + 1 + x * 3;
      raw[at] = clampByte(lerp(r0, r1, t) + jitter);
      raw[at + 1] = clampByte(lerp(g0, g1, t) + jitter);
      raw[at + 2] = clampByte(lerp(b0, b1, t) + jitter);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Blend position 0..1 for the pixel under (x, y) per pattern. */
function patternPosition(
  pattern: DemoImagePatternId,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  switch (pattern) {
    case 'gradient-h':
      return x / Math.max(1, width - 1);
    case 'gradient-v':
      return y / Math.max(1, height - 1);
    case 'gradient-diagonal':
      return (x / Math.max(1, width - 1) + y / Math.max(1, height - 1)) / 2;
    case 'stripes':
      return Math.floor(x / Math.max(1, Math.floor(width / 8))) % 2 === 0 ? 0 : 1;
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}
