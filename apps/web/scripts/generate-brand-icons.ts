import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

/**
 * Brand mark generator (#143): renders the xitter mark - a white ✕ on an
 * indigo→cyan (135°) rounded square, the same gradient as the landing
 * wordmark - and emits every icon surface the web app ships:
 *
 *   src/app/icon.svg        Next favicon convention (crisp at any size)
 *   src/app/icon.png        PNG favicon fallback
 *   src/app/apple-icon.png  Apple touch icon (180×180)
 *   public/brand-192.png    manifest icon
 *   public/brand-512.png    manifest icon
 *
 * Single source of truth: the constants below drive both the SVG and the
 * rasteriser, so the mark can regenerate at any size (no image tooling or
 * dependencies - node:zlib encodes the PNGs). Run: `npm run icons`.
 */

// Mantine shade-6 tokens, matching the wordmark gradient
// (variant="gradient" from="indigo" to="cyan" deg=135).
const FROM = '#4c6ef5'; // indigo 6
const TO = '#15aabf'; // cyan 6
const GRADIENT_DEG = 135;

const RADIUS_RATIO = 0.225; // rounded-square corner radius / size
const CROSS_SPAN_RATIO = 0.46; // ✕ arm length (centre to tip) × 2 / size
const CROSS_THICKNESS_RATIO = 0.135; // ✕ stroke thickness / size
const WHITE = '#ffffff';

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

const FROM_RGB = hexToRgb(FROM);
const TO_RGB = hexToRgb(TO);
const WHITE_RGB = hexToRgb(WHITE);

function markSvg(): string {
  // 135° in CSS gradient terms runs top-left → bottom-right.
  const size = 64;
  const centre = size / 2;
  const halfSpan = (CROSS_SPAN_RATIO * size) / 2;
  const offset = halfSpan * Math.SQRT1_2; // ±45° arm direction components
  const arm = centre - offset;
  const tip = centre + offset;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">`,
    `  <defs>`,
    `    <linearGradient id="xitter-brand" x1="0" y1="0" x2="${size}" y2="${size}" gradientUnits="userSpaceOnUse">`,
    `      <stop offset="0" stop-color="${FROM}"/>`,
    `      <stop offset="1" stop-color="${TO}"/>`,
    `    </linearGradient>`,
    `  </defs>`,
    `  <rect width="${size}" height="${size}" rx="${round2(RADIUS_RATIO * size)}" fill="url(#xitter-brand)"/>`,
    `  <g stroke="${WHITE}" stroke-width="${round2(CROSS_THICKNESS_RATIO * size)}" stroke-linecap="round">`,
    `    <line x1="${round2(arm)}" y1="${round2(arm)}" x2="${round2(tip)}" y2="${round2(tip)}"/>`,
    `    <line x1="${round2(tip)}" y1="${round2(arm)}" x2="${round2(arm)}" y2="${round2(tip)}"/>`,
    `  </g>`,
    `</svg>`,
    ``,
    ``,
  ].join('\n');
  return svg;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// --- PNG encoding (RGBA8, no dependencies beyond node:zlib) -----------------

const CRC_TABLE: number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(rgba: Uint8Array, size: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // Scanlines carry a 0 (None) filter byte each.
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0;
    rgba.subarray(y * size * 4, (y + 1) * size * 4).forEach((byte, i) => {
      raw[rowStart + 1 + i] = byte;
    });
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

// --- Geometry (unit coordinates; y down) -------------------------------------

function sdRoundedRect(px: number, py: number, half: number, radius: number): number {
  const qx = Math.abs(px) - (half - radius);
  const qy = Math.abs(py) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function sdCapsule(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

/** Signed-distance coverage with a one-pixel feather: 0 outside, 1 inside. */
function coverage(sd: number, feather: number): number {
  return Math.max(0, Math.min(1, 0.5 - sd / feather));
}

// 135°: gradient line direction in screen coordinates (y down).
const GRADIENT_RAD = (GRADIENT_DEG * Math.PI) / 180;
const GRADIENT_DIR_X = Math.sin(GRADIENT_RAD);
const GRADIENT_DIR_Y = -Math.cos(GRADIENT_RAD);
const GRADIENT_DOT_EXTENT = (Math.abs(GRADIENT_DIR_X) + Math.abs(GRADIENT_DIR_Y)) / 2;

const CROSS_ARM_OFFSET = (CROSS_SPAN_RATIO / 2) * Math.SQRT1_2;
const CROSS_CAP_RADIUS = CROSS_THICKNESS_RATIO / 2;

/** Gradient stop for a point on the unit tile (0 = indigo, 1 = cyan). */
function gradientT(px: number, py: number): number {
  const dot = px * GRADIENT_DIR_X + py * GRADIENT_DIR_Y;
  return Math.max(0, Math.min(1, 0.5 + dot / (2 * GRADIENT_DOT_EXTENT)));
}

/** White ✕ coverage: the closer capsule of the two ±45° arms, rounded ends. */
function crossCoverage(px: number, py: number, feather: number): number {
  const cross =
    Math.min(
      sdCapsule(px, py, -CROSS_ARM_OFFSET, -CROSS_ARM_OFFSET, CROSS_ARM_OFFSET, CROSS_ARM_OFFSET),
      sdCapsule(px, py, CROSS_ARM_OFFSET, -CROSS_ARM_OFFSET, -CROSS_ARM_OFFSET, CROSS_ARM_OFFSET),
    ) - CROSS_CAP_RADIUS;
  return coverage(cross, feather);
}

/**
 * One supersample in premultiplied RGBA: the gradient tile, with the white
 * ✕ composited over it. Points outside the rounded square are transparent.
 */
function sampleMark(u: number, v: number, feather: number): [number, number, number, number] {
  const px = u - 0.5;
  const py = v - 0.5;
  const tile = coverage(sdRoundedRect(px, py, 0.5, RADIUS_RATIO), feather);
  if (tile <= 0) return [0, 0, 0, 0];
  const glyph = crossCoverage(px, py, feather) * tile;
  const t = gradientT(px, py);
  const channel = (from: number, to: number) => {
    const gradient = from + (to - from) * t;
    return gradient * (1 - glyph) * tile + WHITE_RGB[0]! * glyph * tile;
  };
  return [
    channel(FROM_RGB[0]!, TO_RGB[0]!),
    channel(FROM_RGB[1]!, TO_RGB[1]!),
    channel(FROM_RGB[2]!, TO_RGB[2]!),
    tile,
  ];
}

/** Averaged straight RGBA of one pixel, from its supersamples. */
function pixelColour(
  x: number,
  y: number,
  size: number,
  supersample: number,
): [number, number, number, number] {
  const feather = 1 / (size * supersample);
  let pr = 0;
  let pg = 0;
  let pb = 0;
  let pa = 0; // premultiplied accumulation
  for (let sy = 0; sy < supersample; sy += 1) {
    for (let sx = 0; sx < supersample; sx += 1) {
      const u = (x + (sx + 0.5) / supersample) / size;
      const v = (y + (sy + 0.5) / supersample) / size;
      const [r, g, b, a] = sampleMark(u, v, feather);
      pr += r;
      pg += g;
      pb += b;
      pa += a;
    }
  }
  if (pa <= 0) return [0, 0, 0, 0];
  return [
    Math.round(pr / pa),
    Math.round(pg / pa),
    Math.round(pb / pa),
    Math.round((pa / (supersample * supersample)) * 255),
  ];
}

function renderMark(size: number): Uint8Array {
  const supersample = 4; // 16 samples per pixel edge
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      rgba.set(pixelColour(x, y, size, supersample), (y * size + x) * 4);
    }
  }
  return rgba;
}

// --- Output -------------------------------------------------------------------

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function write(relativePath: string, data: string | Buffer): void {
  const path = join(webRoot, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  process.stdout.write(`brand: wrote ${relativePath}\n`);
}

write('src/app/icon.svg', markSvg());
write('src/app/icon.png', encodePng(renderMark(64), 64));
write('src/app/apple-icon.png', encodePng(renderMark(180), 180));
write('public/brand-192.png', encodePng(renderMark(192), 192));
write('public/brand-512.png', encodePng(renderMark(512), 512));
