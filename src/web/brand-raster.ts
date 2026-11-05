import { deflateSync } from 'node:zlib';

/**
 * The brand mark (same shapes as `FAVICON_SVG` and `BrandMark`) as a PNG of any size, drawn with
 * signed distance functions: AI app directories and registries want square raster icons, and this
 * keeps one drawing in the code instead of binary files to regenerate after a brand change.
 * Coordinates are in the 32×32 units of the SVG.
 */

type Rgb = readonly [number, number, number];

const BACKGROUND: Rgb = [0x1c, 0x1c, 0x1e];
const ACCENT: Rgb = [0xff, 0x6b, 0x1a];

/** Rounded square 0..32 with corner radius 8. */
function roundedSquare(x: number, y: number): number {
  const qx = Math.abs(x - 16) - 16 + 8;
  const qy = Math.abs(y - 16) - 16 + 8;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 8;
}

/** The ring: radius 9 around the centre, from the top clockwise to the left (270°), round caps. */
function ring(x: number, y: number): number {
  const dx = x - 16;
  const dy = y - 16;
  const onArc = !(dx < 0 && dy < 0);
  const distance = onArc
    ? Math.abs(Math.hypot(dx, dy) - 9)
    : Math.min(Math.hypot(x - 16, y - 7), Math.hypot(x - 7, y - 16));
  return distance - 1.4;
}

const disc = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x - cx, y - cy) - r;
const centre = disc(16, 16, 3.4);
const satellite = disc(7, 9.6, 2);

/** Coverage of a shape at a pixel from its distance (in pixels), anti-aliased over one pixel. */
const coverage = (distance: number) => Math.min(1, Math.max(0, 0.5 - distance));

/** RGBA pixels of the mark at `size`×`size`. */
export function brandIconPixels(size: number): Uint8Array {
  const scale = size / 32;
  const pixels = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) / scale;
      const y = (py + 0.5) / scale;
      const base = coverage(roundedSquare(x, y) * scale);
      const accent = Math.max(
        coverage(ring(x, y) * scale),
        coverage(centre(x, y) * scale),
        coverage(satellite(x, y) * scale),
      );
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        pixels[i + c] = Math.round(BACKGROUND[c]! * (1 - accent) + ACCENT[c]! * accent);
      }
      pixels[i + 3] = Math.round(255 * base);
    }
  }
  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, crc]);
}

/** Encodes RGBA pixels as a PNG (8-bit, no filtering). */
export function encodePng(pixels: Uint8Array, width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    rows[y * (width * 4 + 1)] = 0; // filter: none
    rows.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', new Uint8Array()),
  ]);
}

/** Sizes the hub serves (`/icon-<size>.png`). */
export const ICON_SIZES = [48, 96, 192, 512] as const;
export type IconSize = (typeof ICON_SIZES)[number];

const cache = new Map<number, Buffer>();

/** The mark as a PNG, cached per size. */
export function brandIconPng(size: IconSize | number): Buffer {
  let png = cache.get(size);
  if (!png) {
    png = encodePng(brandIconPixels(size), size, size);
    cache.set(size, png);
  }
  return png;
}
