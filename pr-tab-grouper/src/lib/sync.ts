/**
 * 自分のオープン PR をバックグラウンドで定期取得する。
 *
 * MV3 の service worker は常駐しないので setInterval は使えない（数十秒で停止される）。
 * chrome.alarms は service worker を起こしてくれるので、こちらを使う。
 *
 * 取得した一覧は 3 つに効く:
 *   - 判定 … 「自分の PR」の一覧が確定するので、タイトルや DOM を読まずに mine が決まる
 *   - バッジ … オープン PR 件数を出す
 *   - 通知 … レビュー・CI・コンフリクトの状態が変わったときだけ知らせる
 */

import { fetchMyOpenPrs, needsAttention, AuthError } from './api.js';
import { rememberMany } from './cache.js';
import { getSettings } from './settings.js';
import type { PrIndex, PrItem, Settings } from './types.js';

export const ALARM = 'poll-my-prs';
export const INDEX_KEY = 'prIndex';

/** GitHub の API 上限に配慮した下限。chrome.alarms 自体の下限も 1 分。 */
const MIN_MINUTES = 1;
const MAX_MINUTES = 60;

export const clampMinutes = (n: unknown): number =>
  Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Math.round(Number(n) || MIN_MINUTES)));

export async function readIndex(): Promise<PrIndex> {
  const stored = await chrome.storage.local.get(INDEX_KEY);
  return (
    (stored[INDEX_KEY] as PrIndex | undefined) || {
      items: [],
      viewer: null,
      fetchedAt: 0,
      error: null,
    }
  );
}

// ------------------------------------------------------------------ スケジュール

export type ScheduleResult =
  | { scheduled: false; reason: 'off' | 'no-token' }
  | { scheduled: true; periodInMinutes: number };

/** 設定に合わせてアラームを張り直す。設定変更時と起動時に呼ぶ。 */
export async function rescheduleSync(): Promise<ScheduleResult> {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM);

  if (!settings.poll || !settings.token) {
    await setBadge(null, settings);
    return { scheduled: false, reason: settings.token ? 'off' : 'no-token' };
  }

  const periodInMinutes = clampMinutes(settings.pollMinutes);
  // delayInMinutes を同じ値にしないと、設定を触るたびに即実行されて無駄打ちになる
  chrome.alarms.create(ALARM, { periodInMinutes, delayInMinutes: periodInMinutes });
  return { scheduled: true, periodInMinutes };
}

// ------------------------------------------------------------------ バッジ

async function setBadge(index: PrIndex | null, settings: Settings): Promise<void> {
  if (!settings.badge || !index) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  if (index.error) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#bf8700' });
    return;
  }

  const count = index.items.length;
  const attention = index.items.filter(needsAttention).length;
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: attention ? '#d1242f' : '#8250df' });
  await chrome.action.setTitle({
    title: count
      ? `PR Tab Grouper — オープン PR ${count} 件${attention ? `（要対応 ${attention} 件）` : ''}`
      : 'PR Tab Grouper',
  });
}

// ------------------------------------------------------------------ 変化の検出

/** 通知する変化の種類。 */
export type NotifyKind = 'APPROVED' | 'CHANGES_REQUESTED' | 'CI_FAILED' | 'CONFLICT' | 'CLOSED';

const KIND: Record<NotifyKind, { title: string; attention: boolean }> = {
  APPROVED: { title: '承認されました', attention: false },
  CHANGES_REQUESTED: { title: '修正がリクエストされました', attention: true },
  CI_FAILED: { title: 'CI が失敗しました', attention: true },
  CONFLICT: { title: 'コンフリクトしています', attention: true },
  CLOSED: { title: 'クローズまたはマージされました', attention: false },
};

const isNotifyKind = (s: string | null): s is NotifyKind => !!s && s in KIND;

const failed = (s: string | null) => s === 'FAILURE' || s === 'ERROR';

export interface PrEvent {
  kind: NotifyKind;
  pr: PrItem;
}

/**
 * 前回と今回を比べて「知らせる価値のある変化」だけ拾う。
 * 初回（前回が空）は全件が変化に見えてしまうので、呼び出し側で抑止する。
 */
export function diffPrs(prev: PrItem[], next: PrItem[]): PrEvent[] {
  const before = new Map(prev.map((p) => [p.key, p]));
  const events: PrEvent[] = [];

  for (const pr of next) {
    const was = before.get(pr.key);
    if (!was) continue; // 新しく現れた PR（＝自分が作った直後）は通知しない

    if (pr.reviewDecision !== was.reviewDecision && isNotifyKind(pr.reviewDecision)) {
      events.push({ kind: pr.reviewDecision, pr });
    }
    if (failed(pr.checks) && !failed(was.checks)) events.push({ kind: 'CI_FAILED', pr });
    if (pr.mergeable === 'CONFLICTING' && was.mergeable !== 'CONFLICTING') {
      events.push({ kind: 'CONFLICT', pr });
    }
  }

  const after = new Set(next.map((p) => p.key));
  for (const pr of prev) {
    if (!after.has(pr.key)) events.push({ kind: 'CLOSED', pr });
  }
  return events;
}

async function notifyAll(events: PrEvent[]): Promise<void> {
  for (const { kind, pr } of events.slice(0, 5)) {
    // 一度に大量に出しても読めないので上限をつける
    const meta = KIND[kind];
    await chrome.notifications
      .create(`pr|${pr.url}`, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: `${pr.nwo} #${pr.number} — ${meta.title}`,
        message: pr.title,
        priority: meta.attention ? 2 : 0,
      })
      .catch(() => {});
  }
}

// ------------------------------------------------------------------ 本体

let inFlight: Promise<PrIndex> | null = null;

export interface SyncOptions {
  /** 通知を出さない（初回取得や手動更新のとき）。 */
  silent?: boolean;
}

/** 取得してキャッシュ・バッジ・通知に反映する。多重起動は 1 本にまとめる。 */
export function syncMyPrs(options: SyncOptions = {}): Promise<PrIndex> {
  inFlight ??= runSync(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runSync({ silent = false }: SyncOptions = {}): Promise<PrIndex> {
  const settings = await getSettings();
  const prev = await readIndex();

  if (!settings.token) {
    // 未設定は「エラー」ではなく未構成。バッジに ! を出すと壊れたように見えるので消す
    const index: PrIndex = {
      ...prev,
      error: 'Personal Access Token が未設定です',
      fetchedAt: Date.now(),
    };
    await chrome.storage.local.set({ [INDEX_KEY]: index });
    await setBadge(null, settings);
    return index;
  }

  let index: PrIndex;
  try {
    const { items, viewer, source, degraded } = await fetchMyOpenPrs(settings.token);
    index = {
      items,
      viewer,
      source,
      degraded: degraded || null,
      fetchedAt: Date.now(),
      error: null,
      needsAuth: false,
    };
  } catch (e) {
    // 失敗しても前回の一覧は残す。ネットワークが切れただけでバッジが消えると分かりにくい
    index = {
      ...prev,
      error: e instanceof Error ? e.message : String(e),
      needsAuth: e instanceof AuthError,
      fetchedAt: Date.now(),
    };
    await chrome.storage.local.set({ [INDEX_KEY]: index });
    await setBadge(index, settings);
    return index;
  }

  await chrome.storage.local.set({ [INDEX_KEY]: index });

  // 「自分の PR」の確定情報。以後この PR はタイトルを読まなくても判定できる
  // state は「タブを閉じるか」の判定に使う。open で返ってきた時点で OPEN 確定なので上書きする
  await rememberMany(
    index.items.map((pr) => [
      pr.key,
      { author: index.viewer, mine: true, title: pr.title, url: pr.url, state: 'OPEN' as const },
    ])
  );

  await setBadge(index, settings);

  const firstRun = !prev.fetchedAt || !prev.items?.length;
  if (settings.notify && !silent && !firstRun) {
    await notifyAll(diffPrs(prev.items || [], index.items));
  }
  return index;
}
