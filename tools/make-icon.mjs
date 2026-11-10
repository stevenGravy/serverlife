/**
 * Generate build/icon.png — a 1024px app icon, with no image dependencies.
 *
 * electron-builder converts this single PNG into .icns and .ico at package
 * time, so one file covers every platform.
 */

import { deflateSync } from 'zlib';
import { mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

const SIZE = 1024;

/* --- palette --- */
const BG_TOP = [76, 141, 255];     // accent blue
const BG_BOT = [163, 113, 247];    // violet
const INK = [255, 255, 255];

const px = new Uint8Array(SIZE * SIZE * 4);

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Signed distance to a rounded rectangle, for antialiased edges. */
function sdRoundRect(x, y, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(x - cx) - (halfW - r);
  const qy = Math.abs(y - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Distance to a thick line segment, used for the chevron and the bar. */
function sdSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((x - x1) * dx + (y - y1) * dy) / len2;
  t = clamp01(t);
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function put(i, rgb, alpha) {
  if (alpha <= 0) return;
  const a = clamp01(alpha);
  px[i] = Math.round(lerp(px[i], rgb[0], a));
  px[i + 1] = Math.round(lerp(px[i + 1], rgb[1], a));
  px[i + 2] = Math.round(lerp(px[i + 2], rgb[2], a));
  px[i + 3] = Math.round(lerp(px[i + 3], 255, a));
}

const S = SIZE;
const pad = S * 0.06;
const half = (S - pad * 2) / 2;
const radius = S * 0.22;

// Chevron ">" and the underscore, sized off the canvas.
const strokeW = S * 0.062;
const cx1 = S * 0.335, cy1 = S * 0.345;
const cx2 = S * 0.505, cy2 = S * 0.5;
const cx3 = S * 0.335, cy3 = S * 0.655;
const barY = S * 0.675;
const barX1 = S * 0.565, barX2 = S * 0.735;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;

    // Rounded-square body with a vertical gradient.
    const d = sdRoundRect(x + 0.5, y + 0.5, S / 2, S / 2, half, half, radius);
    const bodyA = clamp01(0.5 - d);
    if (bodyA > 0) {
      const t = y / S;
      put(i, [
        lerp(BG_TOP[0], BG_BOT[0], t),
        lerp(BG_TOP[1], BG_BOT[1], t),
        lerp(BG_TOP[2], BG_BOT[2], t),
      ], bodyA);
    }

    // Prompt glyph.
    const dc = Math.min(
      sdSegment(x + 0.5, y + 0.5, cx1, cy1, cx2, cy2),
      sdSegment(x + 0.5, y + 0.5, cx2, cy2, cx3, cy3),
    );
    const db = sdSegment(x + 0.5, y + 0.5, barX1, barY, barX2, barY);
    const ink = Math.min(dc, db) - strokeW / 2;
    put(i, INK, clamp01(0.5 - ink) * bodyA);
  }
}

/* --- PNG encoding (RGBA, no filtering) --- */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crcBuf]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;    // bit depth
ihdr[9] = 6;    // colour type RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

// Each scanline is prefixed with filter byte 0.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const o = y * (SIZE * 4 + 1);
  raw[o] = 0;
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, o + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync('build', { recursive: true });
writeFileSync('build/icon.png', png);
console.log(`build/icon.png  ${SIZE}x${SIZE}  ${(png.length / 1024).toFixed(1)} KB  sha=${createHash('sha1').update(png).digest('hex').slice(0, 8)}`);
