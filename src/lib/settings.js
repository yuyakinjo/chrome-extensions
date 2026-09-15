export const TAB_GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
];

export const DEFAULTS = {
  enabled: true,
  username: 'yuyakinjo', // 自分の GitHub ログイン名。空ならページの meta から推定
  onlyMine: true,
  grouping: 'single', // 'single' | 'repo'
  groupTitle: 'My PRs',
  color: 'purple',
  collapse: false,
  gatherOnCreate: true,

  // --- 認証 ---
  token: '', // アクセストークン。Device Flow で取得したものか、手貼りの PAT
  tokenSource: '', // 'device' | 'pat' | ''
  clientId: '', // OAuth App の Client ID（公開してよい値）
  authLogin: '', // 接続したアカウント名（表示用）
  authScope: 'repo', // 'repo' | 'public_repo'

  // --- バックグラウンドでの定期取得（PAT 必須） ---
  poll: true, // 定期取得の ON/OFF
  pollMinutes: 1, // 取得間隔（分）。chrome.alarms の下限が 1 分
  badge: true, // オープン PR 件数をアイコンに出す
  notify: true, // レビュー / CI の状態が変わったら通知
  autoGroupOnPoll: false, // 取得のたびに開いている PR タブをまとめ直す
};

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...(stored.settings || {}) };
}

export async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
