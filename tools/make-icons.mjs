// Generates the extension's PNG icons (no external deps — hand-rolled PNG encoder).
// A gradient squircle with a white "download" glyph (arrow into a tray).
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

// iOS-style squircle with a blue→indigo gradient, a soft top sheen and a
// white "download" glyph. Supersampled 4× per pixel for clean edges.
function drawIcon(S) {
  const buf = Buffer.alloc(S * S * 4);
  const SS = 4;
  const top = [10, 132, 255];
  const bottom = [94, 92, 230];
  const n = 5; // superellipse exponent (squircle)
  const inSquircle = (fx, fy) => Math.abs(2 * fx - 1) ** n + Math.abs(2 * fy - 1) ** n <= 1;
  const seg = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  const stroke = S <= 16 ? 0.085 : 0.068;
  const inGlyph = (fx, fy) =>
    seg(fx, fy, 0.5, 0.24, 0.5, 0.6) <= stroke ||
    seg(fx, fy, 0.33, 0.45, 0.5, 0.62) <= stroke ||
    seg(fx, fy, 0.67, 0.45, 0.5, 0.62) <= stroke ||
    seg(fx, fy, 0.29, 0.78, 0.71, 0.78) <= stroke;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = (x + (sx + 0.5) / SS) / S;
          const fy = (y + (sy + 0.5) / SS) / S;
          if (!inSquircle(fx, fy)) continue;
          let c;
          if (inGlyph(fx, fy)) c = [255, 255, 255];
          else {
            const t = fy * 0.85 + fx * 0.15;
            c = top.map((v, i) => v + (bottom[i] - v) * t);
            const sheen = Math.max(0, 0.18 - fy * 0.4); // glassy highlight
            c = c.map((v) => v + (255 - v) * sheen);
          }
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const i = (y * S + x) * 4;
      const cov = a / (SS * SS);
      if (!a) continue;
      buf[i] = Math.round(r / a);
      buf[i + 1] = Math.round(g / a);
      buf[i + 2] = Math.round(b / a);
      buf[i + 3] = Math.round(cov * 255);
    }
  }
  return buf;
}

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'src', 'icons');
mkdirSync(outDir, { recursive: true });

for (const S of [16, 32, 48, 128]) {
  const png = encodePNG(S, S, drawIcon(S));
  writeFileSync(join(outDir, `icon-${S}.png`), png);
  console.log(`wrote icon-${S}.png (${png.length} bytes)`);
}
