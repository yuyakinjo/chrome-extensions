/** PR ごとの判定結果キャッシュ。chrome.storage.local に置く。 */

import type { CacheEntry, PrCache } from './types.js';

const CACHE_KEY = 'prCache';
const CACHE_LIMIT = 300;

export async function readCache(): Promise<PrCache> {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return (stored[CACHE_KEY] as PrCache | undefined) || {};
}

function trim(cache: PrCache): PrCache {
  const keys = Object.keys(cache);
  if (keys.length > CACHE_LIMIT) {
    keys
      .sort((a, b) => (cache[a]?.ts || 0) - (cache[b]?.ts || 0))
      .slice(0, keys.length - CACHE_LIMIT)
      .forEach((k) => delete cache[k]);
  }
  return cache;
}

export async function rememberPr(key: string, data: CacheEntry): Promise<void> {
  const cache = await readCache();
  cache[key] = { ...(cache[key] || {}), ...data, ts: Date.now() };
  await chrome.storage.local.set({ [CACHE_KEY]: trim(cache) });
}

/** 定期取得の結果をまとめて反映する。1 件ずつ書くより速い。 */
export async function rememberMany(entries: Array<[string, CacheEntry]>): Promise<void> {
  if (!entries.length) return;
  const cache = await readCache();
  const ts = Date.now();
  for (const [key, data] of entries) cache[key] = { ...(cache[key] || {}), ...data, ts };
  await chrome.storage.local.set({ [CACHE_KEY]: trim(cache) });
}
