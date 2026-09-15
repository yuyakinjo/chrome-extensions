/**
 * 依存ライブラリなしでアイコン PNG を書き出すための道具一式。
 *
 * 拡張機能ごとに違うのは「正規化座標 (0..1) の点に何色を置くか」だけなので、
 * そこを Paint として外から受け取り、アンチエイリアスと PNG 化はここで面倒を見る。
 * 使う側は <ext>/tools/make-icons.ts を参照。
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 正規化座標での色 (0..255)。透明にしたい点は null を返す。 */
export type Paint = (x: number, y: number) => readonly [number, number, number] | null;

export const SIZES = [16, 32, 48, 128];
const SS = 4; // スーパーサンプリング数（1 辺あたり）

// ------------------------------------------------------------------ 形状

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** 中心原点の角丸長方形までの符号付き距離。 */
export function sdRoundRect(
  px: number,
  py: number,
  hw: number,
  hh: number,
  r: number
): number {
  const qx = Math.abs(px) - hw + r;
  const qy = Math.abs(py) - hh + r;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
}

/** 線分までの距離。 */
export function sdSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const vx = bx - ax;
  const vy = by - ay;
  const t = clamp01(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy));
  return Math.hypot(px - ax - vx * t, py - ay - vy * t);
}

// ------------------------------------------------------------------ 描画

function renderRGBA(size: number, paint: Paint): Buffer {
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
          const color = paint((px * SS + sx) * step + half, (py * SS + sy) * step + half);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
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

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba: Buffer, size: number): Buffer {
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

/** icon<size>.png を outDir に書き出す。 */
export function writeIcons(outDir: string, paint: Paint, sizes: number[] = SIZES): void {
  mkdirSync(outDir, { recursive: true });
  for (const size of sizes) {
    const file = join(outDir, `icon${size}.png`);
    writeFileSync(file, encodePng(renderRGBA(size, paint), size));
    console.log(`wrote ${file}`);
  }
}
