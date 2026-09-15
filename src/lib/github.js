/**
 * GitHub の URL / タイトル解析ユーティリティ。
 * content script からは import できないので、必要な分だけ extract.js 側にも持たせている。
 */

const PR_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
const COMPARE_PATH_RE = /^\/([^/]+)\/([^/]+)\/compare(?:\/|$)/;

/**
 * PR ページの <title> は
 *   「<PR タイトル> by <ログイン名> · Pull Request #<番号> · <owner>/<repo>」
 * という形式。DOM に触れずに作者が分かる唯一の経路なので、判定の主役に使う。
 */
const TITLE_AUTHOR_RE =
  /\bby\s+([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\s*[·•]\s*Pull Request\s*#(\d+)/g;

export const GITHUB_HOST = 'github.com';

/** PR ページの URL を {owner, repo, number, key} に分解する。PR ページでなければ null。 */
export function parsePrUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== GITHUB_HOST) return null;
    const m = u.pathname.match(PR_PATH_RE);
    if (!m) return null;
    return {
      owner: m[1],
      repo: m[2],
      number: Number(m[3]),
      key: `${m[1]}/${m[2]}#${m[3]}`,
      nwo: `${m[1]}/${m[2]}`,
    };
  } catch {
    return null;
  }
}

/** PR 作成直前の compare ページかどうか。 */
export function isComparePage(url) {
  try {
    const u = new URL(url);
    return u.hostname === GITHUB_HOST && COMPARE_PATH_RE.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * タブ / ドキュメントのタイトルから PR の作者ログイン名を取り出す。
 * expectedNumber を渡すと「タイトル中の #番号 が URL の PR 番号と一致するか」まで確認するので、
 * PR タイトル自体に紛らわしい文字列が入っていても誤判定しない。
 */
export function authorFromTitle(title, expectedNumber) {
  if (!title) return null;
  let found = null;
  for (const m of title.matchAll(TITLE_AUTHOR_RE)) {
    if (expectedNumber == null || Number(m[2]) === expectedNumber) found = m[1];
  }
  return found;
}

/** 比較用に hash / query を落とした正規化 URL。 */
export function canonicalPrUrl(pr) {
  return `https://${GITHUB_HOST}/${pr.owner}/${pr.repo}/pull/${pr.number}`;
}

/** ログイン名の比較（GitHub のログイン名は大文字小文字を区別しない）。 */
export const sameUser = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
