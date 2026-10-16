// Generates the app and tray icons (PNG) without any dependency: a shield shape rasterized with
// 4x4 supersampling and encoded with zlib. Run: node scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const repo = resolve(import.meta.dirname, '..');

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Shield in unit coordinates (0..1): flat rounded top, straight sides, curved point at the bottom. */
function inShield(u, v, inset = 0) {
  const top = 0.1 + inset;
  const left = 0.16 + inset;
  const right = 0.84 - inset;
  const mid = 0.55;
  const bottom = 0.93 - inset * 1.4;
  if (v < top || u < left || u > right || v > bottom) return false;
  if (v <= mid) return true;
  // lower part narrows towards the point along a curve
  const t = (v - mid) / (bottom - mid);
  const half = ((right - left) / 2) * Math.cos((t * Math.PI) / 2) ** 0.8;
  return Math.abs(u - 0.5) <= half;
}

function coverage(size, x, y, test) {
  let n = 0;
  for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (test((x + (sx + 0.5) / 4) / size, (y + (sy + 0.5) / 4) / size)) n++;
  return n / 16;
}

/** Check mark inside the shield (for the "connected" state). */
function inCheck(u, v) {
  const d = (ax, ay, bx, by) => {
    const t = Math.max(0, Math.min(1, ((u - ax) * (bx - ax) + (v - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
    return Math.hypot(u - (ax + t * (bx - ax)), v - (ay + t * (by - ay)));
  };
  return Math.min(d(0.33, 0.5, 0.46, 0.63), d(0.46, 0.63, 0.69, 0.36)) < 0.055;
}

const outline = (size, filled) => (x, y) => {
  const outer = coverage(size, x, y, (u, v) => inShield(u, v));
  const inner = filled ? 0 : coverage(size, x, y, (u, v) => inShield(u, v, 0.09));
  const check = filled ? coverage(size, x, y, inCheck) : 0;
  return [0, 0, 0, Math.round(255 * Math.max(0, outer - inner - check))];
};

const colored = (size, rgb) => (x, y) => {
  const a = coverage(size, x, y, (u, v) => inShield(u, v));
  return [...rgb, Math.round(255 * a)];
};

const appIcon = (size) => (x, y) => {
  // rounded square background (macOS-style), blue gradient, white shield with check
  const u = x / size;
  const v = y / size;
  const r = 0.22;
  const inset = 0.1;
  const dx = Math.max(inset + r - u, 0, u - (1 - inset - r));
  const dy = Math.max(inset + r - v, 0, v - (1 - inset - r));
  if (u < inset || u > 1 - inset || v < inset || v > 1 - inset || Math.hypot(dx, dy) > r) return [0, 0, 0, 0];
  const shield = coverage(size, x, y, (a, b) => inShield((a - 0.5) / 0.62 + 0.5, (b - 0.52) / 0.62 + 0.5));
  const check = coverage(size, x, y, (a, b) => inCheck((a - 0.5) / 0.62 + 0.5, (b - 0.52) / 0.62 + 0.5));
  const top = [59, 130, 246];
  const bottom = [29, 78, 216];
  const bg = top.map((c, i) => Math.round(c + (bottom[i] - c) * v));
  const s = shield - check;
  return [...bg.map((c) => Math.round(c * (1 - s) + 255 * s)), 255];
};

const write = (file, buf) => {
  mkdirSync(join(repo, file, '..'), { recursive: true });
  writeFileSync(join(repo, file), buf);
  console.log('wrote', file);
};

for (const [name, filled] of [['trayTemplate', false], ['trayActiveTemplate', true]]) {
  write(`resources/tray/${name}.png`, png(16, outline(16, filled)));
  write(`resources/tray/${name}@2x.png`, png(32, outline(32, filled)));
}
write('resources/tray/tray-win.png', png(32, colored(32, [113, 113, 122])));
write('resources/tray/tray-win-active.png', png(32, colored(32, [16, 185, 129])));
write('build/icon.png', png(1024, appIcon(1024)));
