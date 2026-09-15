/**
 * 拡張機能のアイコン（紫の角丸 + 白いブランチマーク）を PNG で生成する。
 * 依存ライブラリなしで動かせるよう、zlib で最小限の PNG を自前で書き出している。
 *
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];
const SS = 4; // スーパーサンプリング数（1 辺あたり）

// ------------------------------------------------------------------ 形状

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 中心原点の角丸長方形までの符号付き距離。 */
function sdRoundRect(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/** 線分までの距離。 */
function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy));
  return Math.hypot(px - ax - vx * t, py - ay - vy * t);
}

const STROKE = 0.075; // 線の半幅（正規化座標）
const DOT = 0.105; // 丸の半径

// 右ブランチが左の幹に合流するカーブ（2 次ベジェを折れ線で近似）
const CURVE = (() => {
  const [p0, p1, p2] = [
    [0.67, 0.44],
    [0.67, 0.62],
    [0.4, 0.62],
  ];
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const u = 1 - t;
    pts.push([
      u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
      u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
    ]);
  }
  return pts;
})();

/** 正規化座標 (0..1) でのグリフまでの距離。 */
function sdGlyph(x, y) {
  let d = Math.min(
    sdSegment(x, y, 0.33, 0.28, 0.33, 0.72) - STROKE, // 左の幹
    sdSegment(x, y, 0.67, 0.28, 0.67, 0.46) - STROKE, // 右のブランチ
    Math.hypot(x - 0.33, y - 0.28) - DOT, // 左上の丸
    Math.hypot(x - 0.33, y - 0.72) - DOT, // 左下の丸
    Math.hypot(x - 0.67, y - 0.28) - DOT // 右上の丸
  );
  for (let i = 1; i < CURVE.length; i++) {
    const [ax, ay] = CURVE[i - 1];
    const [bx, by] = CURVE[i];
    d = Math.min(d, sdSegment(x, y, ax, ay, bx, by) - STROKE);
  }
  return d;
}

// ------------------------------------------------------------------ 描画

function renderRGBA(size) {
  const buf = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);
  const half = step / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx) * step + half;
          const y = (py * SS + sy) * step + half;

          // 背景（角丸 + 縦方向グラデーション）
          if (sdRoundRect(x - 0.5, y - 0.5, 0.5, 0.5, 0.22) > 0) continue;
          const t = y;
          let cr = 0x82 + (0x66 - 0x82) * t;
          let cg = 0x50 + (0x39 - 0x50) * t;
          let cb = 0xdf + (0xba - 0xdf) * t;

          // グリフ（白）
          if (sdGlyph(x, y) <= 0) {
            cr = 0xff;
            cg = 0xff;
            cb = 0xff;
          }
          r += cr;
          g += cg;
          b += cb;
          a += 255;
        }
      }

      const n = SS * SS;
      const i = (py * size + px) * 4;
      const cov = a / n / 255;
      // ストレートアルファなので色は「塗られたサンプル」の平均にする
      const denom = cov > 0 ? n * cov : 1;
      buf[i] = Math.round(r / denom);
      buf[i + 1] = Math.round(g / denom);
      buf[i + 2] = Math.round(b / denom);
      buf[i + 3] = Math.round(cov * 255);
    }
  }
  return buf;
}

// ------------------------------------------------------------------ PNG 出力

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // 10..12: compression / filter / interlace はすべて 0

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: None
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(renderRGBA(size), size));
  console.log(`wrote ${file}`);
}
