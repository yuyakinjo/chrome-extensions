/**
 * content script が共有するグローバル。
 *
 * src/lib/extract.ts と src/content.ts は manifest の content_scripts から
 * 読み込まれる「古典的なスクリプト」で import できないため、ES モジュールではなく
 * globalThis 経由で受け渡ししている。その形をここで宣言する。
 */

/** PR ページから読み取った内容。background へ送る形でもある。 */
interface PrSnapshot {
  url: string;
  viewer: string | null;
  author: string | null;
  title: string | null;
  docTitle: string;
}

interface PrTabGrouperExtractor {
  isPrPage(): boolean;
  prNumber(): number | null;
  viewer(): string | null;
  author(): string | null;
  title(): string | null;
  snapshot(): PrSnapshot | null;
}

declare var __prTabGrouper: PrTabGrouperExtractor | undefined;
/** 再注入されたときに古いインスタンスを止めるためのフック。 */
declare var __prTabGrouperStop: (() => void) | undefined;

/** Navigation API。対応していないブラウザでは undefined。 */
declare var navigation: EventTarget | undefined;
