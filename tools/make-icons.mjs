// Generates the extension's PNG icons (no external deps — hand-rolled PNG encoder).
// A blue rounded square with a white "download" glyph (arrow into a tray).
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

function drawIcon(S) {
  const buf = Buffer.alloc(S * S * 4); // transparent
  const bg = [37, 99, 176, 255];
  const fg = [255, 255, 255, 255];
  const r = 0.2 * S;
  const right = S - 1 - r;

  const inRounded = (x, y) => {
    if (x < r && y < r) return (x - r) ** 2 + (y - r) ** 2 <= r * r;
    if (x > right && y < r) return (x - right) ** 2 + (y - r) ** 2 <= r * r;
    if (x < r && y > right) return (x - r) ** 2 + (y - right) ** 2 <= r * r;
    if (x > right && y > right) return (x - right) ** 2 + (y - right) ** 2 <= r * r;
    return true;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (!inRounded(x, y)) continue;
      const fx = x / S;
      const fy = y / S;
      let c = bg;
      const stem = fx >= 0.43 && fx <= 0.57 && fy >= 0.2 && fy <= 0.52;
      let head = false;
      if (fy >= 0.5 && fy <= 0.72) {
        const hw = 0.24 * (1 - (fy - 0.5) / 0.22);
        if (Math.abs(fx - 0.5) <= hw) head = true;
      }
      const tray = fx >= 0.27 && fx <= 0.73 && fy >= 0.78 && fy <= 0.865;
      if (stem || head || tray) c = fg;
      const i = (y * S + x) * 4;
      buf[i] = c[0];
      buf[i + 1] = c[1];
      buf[i + 2] = c[2];
      buf[i + 3] = c[3];
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
