/** 拡張機能の中で持ち回るデータの形。 */

/** タブグループの色。chrome.tabGroups が受け付ける文字列だけに絞る。 */
export type TabGroupColor = `${chrome.tabGroups.Color}`;

export type Grouping = 'single' | 'repo';
export type TokenSource = 'device' | 'pat' | '';
export type AuthScope = 'repo' | 'public_repo';

export interface Settings {
  enabled: boolean;
  username: string;
  onlyMine: boolean;
  grouping: Grouping;
  groupTitle: string;
  color: TabGroupColor;
  collapse: boolean;
  gatherOnCreate: boolean;

  token: string;
  tokenSource: TokenSource;
  clientId: string;
  authLogin: string;
  authScope: AuthScope;

  poll: boolean;
  pollMinutes: number;
  badge: boolean;
  notify: boolean;
  autoOpenOnPoll: boolean;
  closeMergedOnPoll: boolean;
  autoGroupOnPoll: boolean;
}

// ------------------------------------------------------------------ PR

/** PR ページの URL を分解したもの。 */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
  /** owner/repo#number。キャッシュや一覧の突き合わせに使う一意キー。 */
  key: string;
  nwo: string;
}

export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type CheckState = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED';
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED';

/** 定期取得で得た自分のオープン PR 1 件。 */
export interface PrItem {
  key: string;
  nwo: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  reviewDecision: ReviewDecision | null;
  mergeable: MergeableState | null;
  checks: CheckState | null;
}

/** chrome.storage.local に置く定期取得の結果。 */
export interface PrIndex {
  items: PrItem[];
  viewer: string | null;
  fetchedAt: number;
  error: string | null;
  source?: 'graphql' | 'search';
  /** GraphQL が使えず検索 API に落ちたときの理由。 */
  degraded?: string | null;
  needsAuth?: boolean;
}

/** PR ごとの判定結果キャッシュの 1 件。 */
export interface CacheEntry {
  author?: string | null;
  mine?: boolean;
  title?: string;
  url?: string;
  /** 定期取得か状態確認が書く。「拡張機能が追いかけていた PR」の印でもある。 */
  state?: PrState | null;
  probedAt?: number;
  ts?: number;
}

export type PrCache = Record<string, CacheEntry>;

// ------------------------------------------------------------------ 非表示

/** 要対応かどうかの判定に関わる分だけを切り出した PR の状態。 */
export type HiddenSnapshot = Pick<PrItem, 'reviewDecision' | 'checks' | 'mergeable'>;

/** 「定期取得で開き直さない」印の 1 件。 */
export interface HiddenEntry {
  /** 非表示にした時刻。 */
  at: number;
  /** 非表示にした時点の状態。ここから「要対応に転じたか」を判定する。 */
  seen: HiddenSnapshot;
}

export type HiddenPrs = Record<string, HiddenEntry>;

// ------------------------------------------------------------------ メッセージ

/** ポップアップの「判定結果を見る」に出す内容。 */
export interface Diagnosis {
  ok: boolean;
  /** 診断できなかったときだけ入る（アクティブなタブがない、など）。 */
  reason?: string;
  url?: string | undefined;
  tabTitle?: string | null;
  isPr?: boolean;
  prKey?: string | null;
  author?: string | null;
  authorSource?: AuthorSource | null;
  viewer?: string | null;
  viewerSource?: ViewerSource | null;
  mine?: boolean;
  justCreated?: boolean;
  groupTitle?: string | null;
  groupId?: number;
  poll?: { periodInMinutes?: number | undefined; nextAt: number; autoOpen: boolean } | null;
  index?: { count: number; fetchedAt: number | null; error: string | null };
}

/** 作者・ログイン名をどこから取ったか。ポップアップの表示に使う。 */
export type AuthorSource = 'poll' | 'page' | 'title' | 'cache' | 'probe' | 'api';
export type ViewerSource = 'settings' | 'poll' | 'page' | 'session' | 'api';

/** content script / ポップアップから service worker に送るメッセージ。 */
export type ExtensionMessage =
  | ({ type: 'PR_PAGE'; justCreated: boolean } & Partial<PrSnapshot>)
  | { type: 'GATHER_OPEN'; windowId?: number }
  | { type: 'REGROUP_ACTIVE'; windowId?: number }
  | { type: 'PRUNE_CLOSED'; windowId?: number }
  | { type: 'OPEN_MY_PRS'; windowId?: number }
  | { type: 'GET_PRS'; windowId?: number }
  | { type: 'SYNC_NOW'; windowId?: number }
  | { type: 'OPEN_PR'; url: string; windowId?: number }
  | { type: 'HIDE_PR'; key: string; windowId?: number }
  | { type: 'UNHIDE_PR'; key: string; windowId?: number }
  | { type: 'DIAGNOSE'; windowId?: number };

/** ポップアップから送れるメッセージ（PR_PAGE は content script 専用）。 */
export type PopupMessage = Exclude<ExtensionMessage, { type: 'PR_PAGE' }>;

/** メッセージの種類ごとの応答。`{ ok: true, ...ここ }` が返る。 */
export interface MessageResults {
  GATHER_OPEN: { grouped: number; groups: number };
  REGROUP_ACTIVE: { groupTitle: string };
  PRUNE_CLOSED: { closed: number };
  OPEN_MY_PRS: { opened: number; grouped: number; groups?: number };
  GET_PRS: PrIndex;
  SYNC_NOW: PrIndex;
  OPEN_PR: Record<string, never>;
  HIDE_PR: { closed: number };
  UNHIDE_PR: { opened: number };
  DIAGNOSE: Diagnosis;
}

export type MessageResponse = { ok: boolean; error?: string; reason?: string } & Record<
  string,
  unknown
>;
