/**
 * 生成 PWA 图标（无第三方依赖，纯 Node + zlib 手写 PNG）。
 *
 * 运行：node scripts/generate-icons.mjs
 * 产物：public/pwa-192x192.png、pwa-512x512.png、maskable-512x512.png、apple-touch-icon.png
 *
 * 设计：M3 基线紫底 + 白色卡片 + 淡紫色顶带 + 两条紫色文字占位条，
 * 与首页卡片观感一致；maskable 版本整块铺满、内容留在安全区内。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../public');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const dataBytes = Buffer.from(data);
  const out = Buffer.alloc(12 + dataBytes.length);
  out.writeUInt32BE(dataBytes.length, 0);
  typeBytes.copy(out, 4);
  dataBytes.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBytes, dataBytes])), 8 + dataBytes.length);
  return out;
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PRIMARY = [0x67, 0x50, 0xa4, 255];
const BAND = [0xd0, 0xbc, 0xff, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

function inRoundRect(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x >= rx + w || y >= ry + h) return false;
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r + 0.5 || (x >= rx + r && x <= rx + w - r) || (y >= ry + r && y <= ry + h - r);
}

function drawIcon(size, { maskable }) {
  const rgba = Buffer.alloc(size * size * 4);
  const outerRadius = maskable ? size : size * 0.24;
  const cardX = size * 0.22;
  const cardW = size * 0.56;
  const cardY = size * 0.26;
  const cardH = size * 0.48;
  const cardR = size * 0.08;
  const bandH = size * 0.15;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let color = CLEAR;
      if (inRoundRect(x, y, 0, 0, size, size, outerRadius)) color = PRIMARY;
      if (inRoundRect(x, y, cardX, cardY, cardW, cardH, cardR)) {
        color = y <= cardY + bandH ? BAND : WHITE;
      }
      // 两条文字占位条
      const barX = cardX + size * 0.08;
      const barW = cardW - size * 0.16;
      for (const [by, bh] of [
        [cardY + size * 0.24, size * 0.05],
        [cardY + size * 0.34, size * 0.05],
      ]) {
        if (inRoundRect(x, y, barX, by, barW, bh, bh / 2)) color = [0x67, 0x50, 0xa4, 230];
      }
      const offset = (y * size + x) * 4;
      rgba[offset] = color[0];
      rgba[offset + 1] = color[1];
      rgba[offset + 2] = color[2];
      rgba[offset + 3] = color[3];
    }
  }
  return encodePng(size, size, rgba);
}

writeFileSync(resolve(outDir, 'pwa-192x192.png'), drawIcon(192, { maskable: false }));
writeFileSync(resolve(outDir, 'pwa-512x512.png'), drawIcon(512, { maskable: false }));
writeFileSync(resolve(outDir, 'maskable-512x512.png'), drawIcon(512, { maskable: true }));
writeFileSync(resolve(outDir, 'apple-touch-icon.png'), drawIcon(180, { maskable: false }));

process.stdout.write('icons written to public/\n');
