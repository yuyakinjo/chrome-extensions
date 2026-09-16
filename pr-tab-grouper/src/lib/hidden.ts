/**
 * 「定期取得で開き直さない PR」を覚える。chrome.storage.local に置く。
 *
 * レビューを終えてマージを待つだけの PR は、タブを閉じても次の取得で開き直されてしまう
 * （autoOpenMyPrs は「一覧にあって開いていない PR」を開くため）。ここに印がある PR だけは
 * その対象から外す。
 *
 * 印は永続させる（マージ待ちは数日かかる）が、次の 2 つで自動的に外れる:
 *   - 一覧から消えた … マージ・クローズされたので印ごと捨てる
 *   - 要対応に転じた … 「対応済み」ではなくなったので表示に戻す
 */

import { diffPrs, type NotifyKind } from './sync.js';
import type { HiddenPrs, HiddenSnapshot, PrItem } from './types.js';

const HIDDEN_KEY = 'hiddenPrs';

export async function readHidden(): Promise<HiddenPrs> {
  const stored = await chrome.storage.local.get(HIDDEN_KEY);
  return (stored[HIDDEN_KEY] as HiddenPrs | undefined) || {};
}

const snapshotOf = (pr: PrItem): HiddenSnapshot => ({
  reviewDecision: pr.reviewDecision,
  checks: pr.checks,
  mergeable: pr.mergeable,
});

export async function hidePr(pr: PrItem): Promise<void> {
  const hidden = await readHidden();
  hidden[pr.key] = { at: Date.now(), seen: snapshotOf(pr) };
  await chrome.storage.local.set({ [HIDDEN_KEY]: hidden });
}

/** 印を外す。戻り値は実際に外れた件数。 */
export async function unhidePrs(keys: string[]): Promise<number> {
  const hidden = await readHidden();
  const targets = keys.filter((key) => key in hidden);
  if (!targets.length) return 0;
  for (const key of targets) delete hidden[key];
  await chrome.storage.local.set({ [HIDDEN_KEY]: hidden });
  return targets.length;
}

/** 通知を出すのと同じ変化。これが起きた PR は「対応済み」ではなくなったと見なす。 */
const ATTENTION: ReadonlySet<NotifyKind> = new Set<NotifyKind>([
  'CHANGES_REQUESTED',
  'CI_FAILED',
  'CONFLICT',
]);

/**
 * 非表示にしてから要対応に転じたか。
 *
 * 判定は通知と同じ diffPrs に任せる（非表示にした時点の状態を「前回」として渡す）。
 * こうしておくと「通知が飛ぶ変化」と「タブが戻ってくる変化」が常に一致する。
 */
const becameAttention = (seen: HiddenSnapshot, pr: PrItem): boolean =>
  diffPrs([{ ...pr, ...seen }], [pr]).some((event) => ATTENTION.has(event.kind));

/**
 * 印を今の一覧と突き合わせて、外すべきものを外す。取得のたびに呼ぶ。
 * 戻り値は印が外れた PR の key（＝この回でタブが戻ってくるもの）。
 */
export async function reconcileHidden(items: PrItem[]): Promise<string[]> {
  const hidden = await readHidden();
  const keys = Object.keys(hidden);
  if (!keys.length) return [];

  const byKey = new Map(items.map((pr) => [pr.key, pr]));
  const stale = keys.filter((key) => {
    const pr = byKey.get(key);
    const entry = hidden[key];
    // 一覧から消えた PR は印ごと捨てる。開き直す一覧に載っていないので、外しても開かれない
    return !pr || !entry || becameAttention(entry.seen, pr);
  });

  await unhidePrs(stale);
  return stale;
}
