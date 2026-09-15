/**
 * PR Tab Grouper のアイコン（紫の角丸 + 白いブランチマーク）を PNG で生成する。
 *
 *   bun pr-tab-grouper/tools/make-icons.ts
 *
 * PNG の書き出しとアンチエイリアスは ../../tools/icon.ts が持っている。
 * ここにあるのは「どんな絵にするか」だけ。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdRoundRect, sdSegment, writeIcons, type Paint } from '../../tools/icon.ts';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const STROKE = 0.075; // 線の半幅（正規化座標）
const DOT = 0.105; // 丸の半径

type Point = readonly [number, number];

// 右ブランチが左の幹に合流するカーブ（2 次ベジェを折れ線で近似）
const CURVE: Point[] = (() => {
  const [p0, p1, p2]: Point[] = [
    [0.67, 0.44],
    [0.67, 0.62],
    [0.4, 0.62],
  ];
  const pts: Point[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const u = 1 - t;
    pts.push([
      u * u * p0![0] + 2 * u * t * p1![0] + t * t * p2![0],
      u * u * p0![1] + 2 * u * t * p1![1] + t * t * p2![1],
    ]);
  }
  return pts;
})();

/** 正規化座標 (0..1) でのグリフまでの距離。 */
function sdGlyph(x: number, y: number): number {
  let d = Math.min(
    sdSegment(x, y, 0.33, 0.28, 0.33, 0.72) - STROKE, // 左の幹
    sdSegment(x, y, 0.67, 0.28, 0.67, 0.46) - STROKE, // 右のブランチ
    Math.hypot(x - 0.33, y - 0.28) - DOT, // 左上の丸
    Math.hypot(x - 0.33, y - 0.72) - DOT, // 左下の丸
    Math.hypot(x - 0.67, y - 0.28) - DOT // 右上の丸
  );
  for (let i = 1; i < CURVE.length; i++) {
    const [ax, ay] = CURVE[i - 1]!;
    const [bx, by] = CURVE[i]!;
    d = Math.min(d, sdSegment(x, y, ax, ay, bx, by) - STROKE);
  }
  return d;
}

const paint: Paint = (x, y) => {
  // 背景（角丸 + 縦方向グラデーション）
  if (sdRoundRect(x - 0.5, y - 0.5, 0.5, 0.5, 0.22) > 0) return null;
  // グリフ（白）
  if (sdGlyph(x, y) <= 0) return [0xff, 0xff, 0xff];
  return [0x82 + (0x66 - 0x82) * y, 0x50 + (0x39 - 0x50) * y, 0xdf + (0xba - 0xdf) * y];
};

writeIcons(OUT_DIR, paint);
