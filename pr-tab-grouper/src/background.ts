import {
  parsePrUrl,
  isComparePage,
  canonicalPrUrl,
  authorFromTitle,
  sameUser,
  GITHUB_HOST,
} from './lib/github.js';
import { getSettings } from './lib/settings.js';
import { readCache, rememberPr, rememberMany } from './lib/cache.js';
import { readHidden, hidePr, unhidePrs, reconcileHidden } from './lib/hidden.js';
import { fetchViewer, fetchPrAuthor, fetchPrStates } from './lib/api.js';
import { ALARM, syncMyPrs, rescheduleSync, readIndex } from './lib/sync.js';
import type {
  AuthorSource,
  Diagnosis,
  ExtensionMessage,
  PrCache,
  PrIndex,
  PrRef,
  PrState,
  Settings,
  ViewerSource,
} from './lib/types.js';

/**
 * 「今開いた PR は自分のものか」を判定してタブグループへ入れる。
 *
 * 作者名の取得は確実な順に:
 *   1. 定期取得した自分のオープン PR 一覧（PAT 設定時。GitHub が答えなので最も確実）
 *   2. タブのタイトル「... by <login> · Pull Request #<n> · owner/repo」
 *      DOM に触れないので GitHub のリニューアルに強く、content script すら要らない
 *   3. content script がページから読んだ作者名
 *   4. ページへの再注入（インストール前から開いていたタブ向け）
 *   5. REST API 単発（PAT 設定時のみ）
 *
 * さらに compare ページ -> PR ページの遷移を見ていて、これが取れたときは
 * 作者が分からなくても「たった今自分が作った PR」と断定できる。
 */

const EXTRACT_FILE = 'src/lib/extract.js';
const CONTENT_FILES = [EXTRACT_FILE, 'src/content.js'];

// ------------------------------------------------- compare -> pull の遷移を覚える

const comparedKey = (tabId: number) => `cmp:${tabId}`;
const createdKey = (tabId: number) => `new:${tabId}`;

/** 消さずに確認する。判定できずグループ化しなかったときにフラグを失わないため。 */
async function peekJustCreated(tabId: number, prKey: string): Promise<boolean> {
  const got = await chrome.storage.session.get(createdKey(tabId));
  return got[createdKey(tabId)] === prKey;
}

const consumeJustCreated = (tabId: number) => chrome.storage.session.remove(createdKey(tabId));

// ---------------------------------------------- 「閉じ返さない」PR を覚える（ブラウザを閉じるまで）

const keepKey = (prKey: string) => `keep:${prKey}`;

/**
 * 通知やポップアップから開き直した PR を覚える。
 * 終わった PR のタブは自動で閉じるので、これが無いと開いた 1 分後に閉じ返してしまう。
 */
const keepPrOpen = (prKey: string) => chrome.storage.session.set({ [keepKey(prKey)]: Date.now() });

async function keptOpenKeys(prKeys: string[]): Promise<Set<string>> {
  if (!prKeys.length) return new Set();
  const got = await chrome.storage.session.get(prKeys.map(keepKey));
  return new Set(prKeys.filter((k) => got[keepKey(k)]));
}

// ------------------------------------------ 閉じられたタブがどの PR だったかを控える

const tabPrKey = (tabId: number) => `tab:${tabId}`;

/**
 * onRemoved には URL が来ないので、閉じられる前に控えておく。
 * これが無いと「手で閉じたタブ」を非表示の意思表示として扱えない。
 */
async function noteTabPr(tab: chrome.tabs.Tab, pr: PrRef | null): Promise<void> {
  if (tab.id == null) return;
  // シークレットのタブは定期取得で開き直さないので、控える意味がない
  if (!pr || tab.incognito) await chrome.storage.session.remove(tabPrKey(tab.id));
  else await chrome.storage.session.set({ [tabPrKey(tab.id)]: pr.key });
}

/** 開いている PR タブの控えを取り直す。拡張機能のリロード後の取りこぼしを埋める。 */
async function noteOpenPrTabs(): Promise<void> {
  const entries: Record<string, string> = {};
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null || tab.incognito) continue;
    const pr = parsePrUrl(tab.url || tab.pendingUrl || '');
    if (pr) entries[tabPrKey(tab.id)] = pr.key;
  }
  if (Object.keys(entries).length) await chrome.storage.session.set(entries);
}

/**
 * 手で閉じた PR タブを「非表示」として覚える。これが無いと次の取得で開き直される。
 *
 * 対象は定期取得が open として追いかけている自分の PR だけ。他のタブはそもそも
 * 開き直されないので、印を置いても解除の一覧が汚れるだけになる。
 */
async function hideClosedTab(prKey: string): Promise<void> {
  const settings = await getSettings();
  // 開き直さない設定なら、閉じたタブは閉じたままになる。印は要らない
  if (!settings.autoOpenOnPoll) return;
  const index = await readIndex();
  const pr = index.items.find((item) => item.key === prKey);
  // 拡張機能が閉じるのは一覧から消えた PR のタブだけなので、自動で閉じた分はここで弾かれる
  if (!pr) return;
  await hidePr(pr);
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  (async () => {
    const stored = await chrome.storage.session.get(tabPrKey(tabId));
    const prKey = stored[tabPrKey(tabId)];
    await chrome.storage.session.remove([comparedKey(tabId), createdKey(tabId), tabPrKey(tabId)]);
    // ウィンドウごと閉じたときは「このタブを消したい」ではないので、印は置かない
    if (typeof prKey === 'string' && !removeInfo.isWindowClosing) await hideClosedTab(prKey);
  })().catch(() => {});
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    if (isComparePage(changeInfo.url)) {
      await chrome.storage.session.set({ [comparedKey(tabId)]: Date.now() });
    } else {
      const pr = parsePrUrl(changeInfo.url);
      if (pr && (await chrome.storage.session.get(comparedKey(tabId)))[comparedKey(tabId)]) {
        await chrome.storage.session.set({ [createdKey(tabId)]: pr.key });
        await chrome.storage.session.remove(comparedKey(tabId));
      }
    }
  }

  // 手で閉じられたときに「どの PR だったか」を引けるようにしておく
  if (changeInfo.url || changeInfo.status === 'complete') {
    await noteTabPr(tab, parsePrUrl(tab.url || tab.pendingUrl || '')).catch(() => {});
  }

  // タイトルは URL より少し遅れて決まるので、title / complete の両方で判定し直す
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    await evaluateAndGroup(tab).catch(() => {});
  }
});

// ---------------------------------------------------------- 定期取得のライフサイクル

// service worker は常駐しないので、リスナーは必ずトップレベルで登録する
async function startPolling({ reflect = false }: { reflect?: boolean } = {}): Promise<void> {
  const { scheduled } = await rescheduleSync();
  if (!scheduled) return;
  // 初回は通知を出さない（既存の状態を「変化」として全部知らせてしまうため）
  const index = await syncMyPrs({ silent: true }).catch(() => null);
  // 拡張機能をリロードした直後は、次のアラーム（最大 1 分後）を待たずに反映する。
  // ブラウザ起動時はタブの復元と競合して同じ PR を二重に開きかねないので、待つ
  if (reflect && index) await reflectIndexOnTabs(index).catch(() => {});
}

/**
 * 取得結果をタブに反映する。PR ページを開いていなくても
 * 「1 PR = 1 タブ + タブグループ」の状態になるのはここ。
 */
async function reflectIndexOnTabs(index: PrIndex): Promise<void> {
  const settings = await getSettings();
  // 取得に失敗した回の一覧は前回のものなので、それを元にタブを開いたり閉じたりしない
  const fresh = !index.error;
  const gather = settings.autoGroupOnPoll && settings.enabled;

  // 手で閉じたタブを拾えるよう控えを取り直す。拡張機能のリロード直後もここで揃う
  await noteOpenPrTabs().catch(() => {});
  // 非表示の解除はタブを開く前に済ませる（要対応に転じた PR はこの回で戻ってくる）
  if (fresh) await reconcileHidden(index.items || []).catch(() => []);

  // 終わった PR のタブを片付けてから、足りないタブを開く
  if (fresh && settings.closeMergedOnPoll) await pruneClosedPrTabs(index, settings);

  if (!(fresh && settings.autoOpenOnPoll) && !gather) return;

  const windowId = await pollTargetWindowId();
  if (windowId == null) return; // 通常ウィンドウが 1 つも開いていない

  if (fresh && settings.autoOpenOnPoll) await autoOpenMyPrs(index, windowId, settings);
  // 取得のたびにまとめ直す。既定は OFF（手で外したタブを勝手に戻さないため）
  if (gather) await gatherPrTabs(windowId, settings);
}

/** 裏でタブを開く先。通常ウィンドウだけを対象にし、シークレットは避ける。 */
async function pollTargetWindowId(): Promise<number | null> {
  const usable = (w: chrome.windows.Window | null | undefined): w is chrome.windows.Window =>
    !!w && w.type === 'normal' && !w.incognito;
  const last = await chrome.windows.getLastFocused().catch(() => null);
  if (usable(last)) return last.id ?? null;
  const all = await chrome.windows.getAll().catch(() => []);
  return all.find(usable)?.id ?? null;
}

/**
 * 拡張機能をリロード／更新すると、既に開いているタブの content script は
 * 無効化されたまま残る（chrome.runtime が消え、通知が届かなくなる）。
 * タブを 1 枚ずつ再読み込みさせずに済むよう、こちらから入れ直す。
 */
async function reinjectContentScripts(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: `https://${GITHUB_HOST}/*` });
  await Promise.all(
    tabIdsOf(tabs).map((tabId) =>
      chrome.scripting
        .executeScript({ target: { tabId }, files: CONTENT_FILES })
        .catch(() => {}) // 既に別ページへ遷移した、権限がないなど
    )
  );
}

/** chrome.tabs.Tab.id は「タブではないもの」を表すために省略されうるので、都度ふるい落とす。 */
const tabIdsOf = (tabs: chrome.tabs.Tab[]): number[] =>
  tabs.map((t) => t.id).filter((id): id is number => id != null);

chrome.runtime.onInstalled.addListener(() => {
  startPolling({ reflect: true }).catch(() => {});
  reinjectContentScripts().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  startPolling().catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  (async () => {
    await reflectIndexOnTabs(await syncMyPrs());
  })().catch(() => {});
});

// 設定が変わったら張り直す。ポップアップからでも options からでも効くようにここで見る
const SCHEDULE_KEYS = ['poll', 'pollMinutes', 'token'] as const satisfies readonly (keyof Settings)[];
// ON にした瞬間に効かせたい設定。次のアラームまで待たされると効いたのか分からない
const REFLECT_KEYS = [
  'autoOpenOnPoll',
  'closeMergedOnPoll',
] as const satisfies readonly (keyof Settings)[];
chrome.storage.onChanged.addListener(async (changes, area) => {
  const change = changes['settings'];
  if (area !== 'local' || !change) return;
  const oldValue = (change.oldValue ?? {}) as Partial<Settings>;
  const newValue = (change.newValue ?? {}) as Partial<Settings>;

  if (SCHEDULE_KEYS.some((k) => oldValue[k] !== newValue[k])) {
    await rescheduleSync();
    if (newValue.poll && newValue.token) {
      const index = await syncMyPrs({ silent: true }).catch(() => null);
      if (index) await reflectIndexOnTabs(index).catch(() => {});
    }
    return;
  }

  if (REFLECT_KEYS.some((k) => !oldValue[k] && newValue[k])) {
    await reflectIndexOnTabs(await readIndex()).catch(() => {});
  }
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('pr|')) return;
  chrome.notifications.clear(id);
  await openOrFocus(id.slice(3));
});

// ------------------------------------------------------------ グループ操作

function groupTitleFor(settings: Settings, pr: PrRef): string {
  return settings.grouping === 'repo' ? pr.nwo : settings.groupTitle || 'My PRs';
}

/** 同じウィンドウに同名グループがあれば使い回し、なければ作る。 */
async function addTabsToGroup(
  tabIds: number[],
  windowId: number,
  title: string,
  settings: Settings
): Promise<number | null> {
  if (!isNonEmpty(tabIds)) return null;

  const existing = (await chrome.tabGroups.query({ windowId })).find((g) => g.title === title);

  if (existing) {
    const targets: number[] = [];
    for (const id of tabIds) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab && tab.groupId !== existing.id) targets.push(id);
    }
    if (!isNonEmpty(targets)) return existing.id;
    await chrome.tabs.group({ tabIds: targets, groupId: existing.id });
    return existing.id;
  }

  const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
  await chrome.tabGroups.update(groupId, {
    title,
    color: settings.color,
    collapsed: !!settings.collapse,
  });
  return groupId;
}

/** chrome.tabs.group の tabIds は「1 件以上」の形でしか受け付けない。 */
const isNonEmpty = (ids: number[]): ids is [number, ...number[]] => ids.length > 0;

/** タイトルごとのタブ ID を貯める。グループ化はまとめて 1 回だけ行いたいため。 */
function bucket(buckets: Map<string, number[]>, title: string, tabId: number): void {
  const list = buckets.get(title);
  if (list) list.push(tabId);
  else buckets.set(title, [tabId]);
}

/** 既に開いていればそのタブへ、なければ新しいタブで開く。 */
async function openOrFocus(url: string, windowId?: number): Promise<chrome.tabs.Tab | null> {
  const target = parsePrUrl(url);
  // ここへ来るのは通知やポップアップからの明示的な操作だけ。閉じた PR でも閉じ返さない
  if (target) {
    await keepPrOpen(target.key);
    await unhidePrs([target.key]); // 自分で開いたものは「非表示」ではない
  }

  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => {
    const p = parsePrUrl(t.url || t.pendingUrl || '');
    return p && target && p.key === target.key;
  });

  if (hit?.id != null) {
    await chrome.tabs.update(hit.id, { active: true });
    await chrome.windows.update(hit.windowId, { focused: true });
    return hit;
  }
  // 通知から呼ばれたときは windowId が無い。undefined を渡さずキーごと落とす
  return chrome.tabs.create({ url, active: true, ...(windowId ? { windowId } : {}) });
}

// ------------------------------------------------------------ ページの読み取り

/**
 * 既に開いているタブから作者情報を読む。
 * インストール前から開いていたタブには content script が入っていないので、
 * 同じ抽出コードをその場で注入して実行する。
 */
async function probeTab(tabId: number): Promise<PrSnapshot | null> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [EXTRACT_FILE] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__prTabGrouper?.snapshot() ?? null,
    });
    return res?.result ?? null;
  } catch {
    return null; // 権限のないページ、まだ読み込み中など
  }
}

// ------------------------------------------------------- 自分の PR かどうかの判定

/** content script や DOM 読み取りから渡ってくる手掛かり。 */
interface Hint {
  author?: string | null;
  viewer?: string | null;
  justCreated?: boolean;
}

/** 設定のユーザー名を最優先。次に定期取得の結果、ページの meta、最後に API。 */
async function resolveViewer(
  settings: Settings,
  hint: Hint
): Promise<{ viewer: string | null; viewerSource: ViewerSource | null }> {
  const configured = settings.username?.trim();
  if (configured) return { viewer: configured, viewerSource: 'settings' };

  const { viewer: fromIndex } = await readIndex();
  if (fromIndex) return { viewer: fromIndex, viewerSource: 'poll' };

  if (hint?.viewer) {
    await chrome.storage.session.set({ viewer: hint.viewer });
    return { viewer: hint.viewer, viewerSource: 'page' };
  }

  const cached = (await chrome.storage.session.get('viewer'))['viewer'] as string | undefined;
  if (cached) return { viewer: cached, viewerSource: 'session' };

  if (settings.token) {
    const viewer = await fetchViewer(settings.token);
    if (viewer) {
      await chrome.storage.session.set({ viewer });
      return { viewer, viewerSource: 'api' };
    }
  }
  return { viewer: null, viewerSource: null };
}

interface AuthorResult {
  author: string | null;
  authorSource: AuthorSource | null;
  /** 定期取得で「自分の PR」と確定しているもの。ログイン名の比較を待たずに決めてよい。 */
  certainlyMine?: boolean;
  viewer?: string | null;
}

/** deep=true のときだけページ再注入 / API まで踏み込む。 */
async function resolveAuthor(
  tab: chrome.tabs.Tab,
  pr: PrRef,
  hint: Hint,
  settings: Settings,
  cache: PrCache,
  deep: boolean
): Promise<AuthorResult> {
  // 定期取得で「自分の PR」と確定しているものが最優先。GitHub 自身の回答なので迷わない
  const known = cache?.[pr.key];
  if (known?.mine === true && known.author) {
    return { author: known.author, authorSource: 'poll', certainlyMine: true };
  }

  if (hint?.author) return { author: hint.author, authorSource: 'page' };

  const fromTitle = authorFromTitle(tab.title, pr.number);
  if (fromTitle) return { author: fromTitle, authorSource: 'title' };

  if (known?.author) return { author: known.author, authorSource: 'cache' };

  if (!deep) return { author: null, authorSource: null };

  const snap = tab.id == null ? null : await probeTab(tab.id);
  if (snap?.author) return { author: snap.author, authorSource: 'probe', viewer: snap.viewer };

  if (settings.token) {
    const author = await fetchPrAuthor(pr, settings.token);
    if (author) return { author, authorSource: 'api' };
  }
  return { author: null, authorSource: null };
}

/** 判定結果。pr が null なら PR ページではない。 */
interface Classification {
  pr: PrRef | null;
  settings: Settings;
  justCreated: boolean;
  mine: boolean;
  author: string | null;
  authorSource: AuthorSource | null;
  viewer: string | null;
  viewerSource: ViewerSource | null;
}

/** 1 つのタブについて「自分の PR か」を判定する（グループ化はしない）。 */
async function classifyTab(
  tab: chrome.tabs.Tab,
  hint: Hint = {},
  { deep = false, cache = null }: { deep?: boolean; cache?: PrCache | null } = {}
): Promise<Classification> {
  const settings = await getSettings();
  const pr = parsePrUrl(tab.url || tab.pendingUrl || '');
  if (!pr) return { ...EMPTY_CLASSIFICATION, settings };

  const prCache = cache ?? (await readCache());
  const a = await resolveAuthor(tab, pr, hint, settings, prCache, deep);
  const v = await resolveViewer(settings, { viewer: hint.viewer || a.viewer });

  const justCreated =
    hint.justCreated || (tab.id != null && (await peekJustCreated(tab.id, pr.key)));
  const mine = justCreated || a.certainlyMine === true || sameUser(a.author, v.viewer);

  return {
    pr,
    settings,
    justCreated,
    mine,
    author: a.author,
    authorSource: a.authorSource,
    viewer: v.viewer,
    viewerSource: v.viewerSource,
  };
}

/** PR ページではなかったときの判定結果。settings だけ呼び出し側で埋める。 */
const EMPTY_CLASSIFICATION = {
  pr: null,
  justCreated: false,
  mine: false,
  author: null,
  authorSource: null,
  viewer: null,
  viewerSource: null,
} satisfies Omit<Classification, 'settings'>;

/** グループ化の結果。ポップアップと content script への応答になる。 */
interface GroupOutcome {
  ok: boolean;
  reason?: string;
  grouped?: boolean;
  mine?: boolean;
  justCreated?: boolean;
}

/** 判定してグループ化まで行う。onUpdated と content script の両方から呼ばれる。 */
async function evaluateAndGroup(
  tab: chrome.tabs.Tab | undefined,
  hint: Hint = {}
): Promise<GroupOutcome> {
  if (!tab || tab.id == null || tab.incognito || tab.pinned) {
    return { ok: false, reason: 'skip-tab' };
  }

  const c = await classifyTab(tab, hint, { deep: false });
  if (!c.pr) return { ok: false, reason: 'not-pr' };

  // 判定できたものだけキャッシュに残す（不明を「自分のではない」と決めつけない）
  if (c.author || c.justCreated) {
    await rememberPr(c.pr.key, {
      author: c.author,
      ...(c.author && c.viewer ? { mine: c.mine } : {}),
      ...(c.justCreated ? { mine: true } : {}),
      url: canonicalPrUrl(c.pr),
    });
  }

  if (!c.settings.enabled) return { ok: true, grouped: false, reason: 'disabled' };
  if (c.settings.onlyMine && !c.mine) {
    return { ok: true, grouped: false, reason: c.author ? 'not-mine' : 'author-unknown' };
  }

  await addTabsToGroup([tab.id], tab.windowId, groupTitleFor(c.settings, c.pr), c.settings);

  if (c.justCreated) {
    await consumeJustCreated(tab.id);
    // PR を作った瞬間だけ、既に開いている自分の PR タブも同じグループへ寄せる
    if (c.settings.gatherOnCreate) await gatherPrTabs(tab.windowId, c.settings);
  }

  return { ok: true, grouped: true, mine: c.mine, justCreated: c.justCreated };
}

/** ウィンドウ内の PR タブを走査して、自分の PR をグループへ集める。 */
async function gatherPrTabs(
  windowId: number,
  settings: Settings
): Promise<{ grouped: number; groups: number }> {
  const [tabs, cache] = await Promise.all([chrome.tabs.query({ windowId }), readCache()]);

  const buckets = new Map<string, number[]>();
  for (const tab of tabs) {
    if (tab.pinned || tab.id == null) continue;
    const c = await classifyTab(tab, {}, { deep: true, cache });
    if (!c.pr) continue;
    if (c.author && c.viewer) {
      cache[c.pr.key] = { ...cache[c.pr.key], author: c.author, mine: c.mine };
    }
    if (settings.onlyMine && !c.mine) continue;

    bucket(buckets, groupTitleFor(settings, c.pr), tab.id);
  }

  let grouped = 0;
  for (const [title, tabIds] of buckets) {
    await addTabsToGroup(tabIds, windowId, title, settings);
    grouped += tabIds.length;
  }
  return { grouped, groups: buckets.size };
}

/** PR を裏で 1 枚開く。定期取得と「非表示を戻す」で共有する。 */
async function createPrTab(url: string, windowId: number): Promise<number | null> {
  const tab = await chrome.tabs.create({ url, windowId, active: false }).catch(() => null);
  if (!tab?.id) return null; // ウィンドウが閉じられた直後など
  await noteTabPr(tab, parsePrUrl(url));
  return tab.id;
}

/** その PR のタブを閉じる。非表示にしたときの後片付け。 */
async function closePrTabs(prKey: string): Promise<number> {
  let closed = 0;
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null || tab.pinned || tab.incognito) continue;
    if (parsePrUrl(tab.url || tab.pendingUrl || '')?.key !== prKey) continue;
    await chrome.tabs.remove(tab.id).catch(() => {}); // 既に閉じられていた場合
    closed++;
  }
  return closed;
}

/** 既に開いている PR タブの key の集合。同じ PR を 2 枚開かないための判定に使う。 */
async function openPrKeys(query: chrome.tabs.QueryInfo = {}): Promise<Set<string>> {
  const tabs = await chrome.tabs.query(query);
  return new Set(
    tabs
      .map((t) => parsePrUrl(t.url || t.pendingUrl || ''))
      .filter((p): p is PrRef => p != null)
      .map((p) => p.key)
  );
}

/**
 * 定期取得の結果をタブへ反映する。足りない PR だけを裏で開いてグループへ入れる。
 *
 * 既に開いている PR タブには触らない。毎分走るので、gather のように全部を集め直すと
 * 手でグループから外したタブを 1 分後に引き戻してしまう。
 */
async function autoOpenMyPrs(
  index: PrIndex,
  windowId: number,
  settings: Settings
): Promise<{ opened: number; grouped: number }> {
  if (!index.items?.length) return { opened: 0, grouped: 0 };

  // 重複判定は全ウィンドウを見る。別ウィンドウで開いている PR を 2 枚目として開かないため
  const [already, hidden] = await Promise.all([openPrKeys(), readHidden()]);

  const buckets = new Map<string, number[]>();
  let opened = 0;
  for (const pr of index.items) {
    const parsed = parsePrUrl(pr.url);
    // 非表示にした PR はここで外れる。手で閉じたタブが 1 分後に戻ってこないのはこれのため
    if (!parsed || already.has(parsed.key) || hidden[parsed.key]) continue;

    const tabId = await createPrTab(pr.url, windowId);
    if (tabId == null) continue;
    already.add(parsed.key);
    opened++;

    bucket(buckets, groupTitleFor(settings, parsed), tabId);
  }

  // 開いたタブは onUpdated 側でも判定されるが、タイトルが決まるまで待たずにここで入れてしまう
  // （定期取得で mine:true が確定しているので、ページを読む必要がない）
  let grouped = 0;
  if (settings.enabled) {
    for (const [title, tabIds] of buckets) {
      await addTabsToGroup(tabIds, windowId, title, settings);
      grouped += tabIds.length;
    }
  }
  return { opened, grouped };
}

const DONE_STATES: ReadonlySet<PrState> = new Set<PrState>(['MERGED', 'CLOSED']);

/** 「もう閉じてよい PR」か。state は未取得だと null/undefined になりうる。 */
const isDone = (state: PrState | null | undefined): boolean => state != null && DONE_STATES.has(state);
const PROBE_COOLDOWN = 60 * 60 * 1000; // 確認できなかった PR を毎分聞き直さないための間隔
const PROBE_LIMIT = 20; // 1 回の取得で状態を確認する上限
const FORCE_PROBE_LIMIT = 60; // 手動で掃除するときは待ってくれるので多めに見る

/**
 * マージ / クローズされた PR のタブを閉じる。
 *
 * タブを閉じるのは戻せないので、閉じる条件を絞っている:
 *   - 定期取得が「自分のオープン PR」として追いかけていた PR だけ（cache に state がある）。
 *     自分で開き直した昔の PR や他人の PR を勝手に閉じないため
 *   - 一覧から消えただけでは閉じず、GitHub に MERGED / CLOSED を確認してから閉じる。
 *     open PR が 100 件を超えたり取得が揺れたときも一覧からは消えるため
 *   - 今見ているタブ、拡張機能から開き直したタブは閉じない
 *
 * force（ポップアップのボタン）のときは、ユーザーが今それを望んで押しているので
 * これらの遠慮をやめる。追いかけていなかった PR タブの掃除はこちらで行う。
 */
async function pruneClosedPrTabs(
  index: PrIndex,
  settings: Settings,
  { force = false }: { force?: boolean } = {}
): Promise<{ closed: number }> {
  const openKeys = new Set((index.items || []).map((p) => p.key));
  const [tabs, cache] = await Promise.all([chrome.tabs.query({}), readCache()]);

  const candidates: Array<{
    tab: chrome.tabs.Tab;
    tabId: number;
    pr: PrRef;
    state: PrState | null | undefined;
    probedAt: number;
  }> = [];
  for (const tab of tabs) {
    if (tab.pinned || tab.incognito || tab.id == null) continue;
    const pr = parsePrUrl(tab.url || tab.pendingUrl || '');
    if (!pr || openKeys.has(pr.key)) continue;

    // mine だけでは足りない。state は定期取得か状態確認が書くので、
    // 「拡張機能が open PR として追いかけていた」ことの印になる
    const known = cache[pr.key];
    if (known?.mine !== true) continue;
    if (!force && known.state == null) continue;
    candidates.push({ tab, tabId: tab.id, pr, state: known.state, probedAt: known.probedAt || 0 });
  }
  if (!candidates.length) return { closed: 0 };

  const kept = force ? new Set<string>() : await keptOpenKeys(candidates.map((c) => c.pr.key));
  const targets = candidates.filter((c) => !kept.has(c.pr.key));

  // 状態が分かっていないものを GitHub に確認する（GraphQL なら 1 リクエストで済む）
  const unknown = targets
    .filter((c) => !isDone(c.state) && (force || Date.now() - c.probedAt > PROBE_COOLDOWN))
    .slice(0, force ? FORCE_PROBE_LIMIT : PROBE_LIMIT);

  if (unknown.length && settings.token) {
    const states = await fetchPrStates(
      unknown.map((c) => c.pr),
      settings.token
    ).catch((): Record<string, PrState> => ({}));

    // 確認できなかったものは state を消さずに probedAt だけ進める（1 時間あけて聞き直す）
    await rememberMany(
      unknown.map((c) => [
        c.pr.key,
        { state: states[c.pr.key] ?? c.state ?? null, probedAt: Date.now() },
      ])
    );
    for (const c of unknown) c.state = states[c.pr.key] ?? c.state;
  }

  // 今見ているタブは閉じない。読んでいる最中に足元から消えるのを避ける
  const active = force
    ? new Set<number>()
    : new Set(tabIdsOf(await chrome.tabs.query({ active: true })));

  let closed = 0;
  for (const c of targets) {
    if (!isDone(c.state) || active.has(c.tabId)) continue;
    await chrome.tabs.remove(c.tabId).catch(() => {}); // 既に閉じられていた場合
    closed++;
  }
  return { closed };
}

/** 自分のオープン PR をまとめて開いてグループ化する。 */
async function openMyPrs(
  windowId: number
): Promise<{ opened: number; grouped: number; groups: number }> {
  const settings = await getSettings();
  if (!settings.token) throw new Error('Personal Access Token が未設定です');

  // 定期取得の結果をそのまま使う。古ければ取り直す
  let index = await readIndex();
  if (!index.fetchedAt || Date.now() - index.fetchedAt > 60_000) {
    index = await syncMyPrs({ silent: true });
  }
  if (index.error && !index.items.length) throw new Error(index.error);
  if (!index.items.length) return { opened: 0, grouped: 0, groups: 0 };

  const [already, hidden] = await Promise.all([openPrKeys({ windowId }), readHidden()]);

  let opened = 0;
  for (const pr of index.items) {
    const parsed = parsePrUrl(pr.url);
    // 非表示にした PR は手動でもここでは開かない。戻すのはポップアップの「戻す」だけ
    if (!parsed || already.has(parsed.key) || hidden[parsed.key]) continue;
    if ((await createPrTab(pr.url, windowId)) == null) continue;
    opened++;
  }

  return { opened, ...(await gatherPrTabs(windowId, settings)) };
}

/** ポップアップの「判定結果」表示用。なぜグループ化されないのかを可視化する。 */
async function diagnose(tab: chrome.tabs.Tab | null): Promise<Diagnosis> {
  if (!tab) return { ok: true, reason: 'no-tab' };
  const c = await classifyTab(tab, {}, { deep: true });
  const alarm = await chrome.alarms.get(ALARM);
  const index = await readIndex();
  return {
    ok: true,
    url: tab.url,
    tabTitle: tab.title || null,
    isPr: !!c.pr,
    prKey: c.pr?.key ?? null,
    author: c.author ?? null,
    authorSource: c.authorSource ?? null,
    viewer: c.viewer ?? null,
    viewerSource: c.viewerSource ?? null,
    mine: c.mine ?? false,
    justCreated: c.justCreated ?? false,
    groupTitle: c.pr ? groupTitleFor(c.settings, c.pr) : null,
    groupId: tab.groupId,
    poll: alarm
      ? {
          periodInMinutes: alarm.periodInMinutes,
          nextAt: alarm.scheduledTime,
          autoOpen: !!c.settings.autoOpenOnPoll,
        }
      : null,
    index: { count: index.items.length, fetchedAt: index.fetchedAt, error: index.error },
  };
}

// ------------------------------------------------------------ メッセージ処理

const currentWindowId = async (given?: number): Promise<number> =>
  given ?? (await chrome.windows.getLastFocused()).id ?? chrome.windows.WINDOW_ID_CURRENT;
const activeTab = async (windowId: number): Promise<chrome.tabs.Tab | null> =>
  (await chrome.tabs.query({ active: true, windowId }))[0] ?? null;

chrome.runtime.onMessage.addListener((msg: ExtensionMessage, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'PR_PAGE': {
          if (sender.tab?.id == null) return sendResponse({ ok: false, reason: 'no-tab' });
          // sender.tab のタイトルは古いことがあるので取り直す
          const tab = (await chrome.tabs.get(sender.tab.id).catch(() => null)) ?? sender.tab;
          return sendResponse(
            await evaluateAndGroup(tab, {
              author: msg.author,
              viewer: msg.viewer,
              justCreated: msg.justCreated,
            })
          );
        }
        case 'GATHER_OPEN': {
          const windowId = await currentWindowId(msg.windowId);
          const result = await gatherPrTabs(windowId, await getSettings());
          return sendResponse({ ok: true, ...result });
        }
        case 'REGROUP_ACTIVE': {
          const windowId = await currentWindowId(msg.windowId);
          const tab = await activeTab(windowId);
          if (!tab) return sendResponse({ ok: false, error: 'アクティブなタブがありません' });
          const c = await classifyTab(tab, {}, { deep: true });
          if (!c.pr) return sendResponse({ ok: false, error: 'PR ページではありません' });
          if (tab.id == null) return sendResponse({ ok: false, error: 'タブを特定できません' });
          await addTabsToGroup([tab.id], tab.windowId, groupTitleFor(c.settings, c.pr), c.settings);
          await rememberPr(c.pr.key, { author: c.author, mine: true, url: canonicalPrUrl(c.pr) });
          await keepPrOpen(c.pr.key); // 手でグループに入れたタブを自動で閉じない
          return sendResponse({ ok: true, groupTitle: groupTitleFor(c.settings, c.pr) });
        }
        case 'PRUNE_CLOSED': {
          const settings = await getSettings();
          if (!settings.token) throw new Error('GitHub と接続されていません');
          // 一覧が古いと確認リクエストが増えるだけなので、先に取り直す
          let index = await readIndex();
          if (!index.fetchedAt || Date.now() - index.fetchedAt > 60_000) {
            index = await syncMyPrs({ silent: true });
          }
          const res = await pruneClosedPrTabs(index, settings, { force: true });
          return sendResponse({ ok: true, ...res });
        }
        case 'OPEN_MY_PRS': {
          const windowId = await currentWindowId(msg.windowId);
          return sendResponse({ ok: true, ...(await openMyPrs(windowId)) });
        }
        case 'GET_PRS':
          return sendResponse({ ok: true, ...(await readIndex()) });
        case 'SYNC_NOW': {
          const index = await syncMyPrs({ silent: true });
          const settings = await getSettings();
          if (settings.autoGroupOnPoll) {
            await gatherPrTabs(await currentWindowId(msg.windowId), settings);
          }
          return sendResponse({ ok: true, ...index });
        }
        case 'OPEN_PR': {
          await openOrFocus(msg.url, await currentWindowId(msg.windowId));
          return sendResponse({ ok: true });
        }
        case 'HIDE_PR': {
          const index = await readIndex();
          const pr = index.items.find((item) => item.key === msg.key);
          if (!pr) return sendResponse({ ok: false, error: '一覧にない PR です' });
          await hidePr(pr);
          return sendResponse({ ok: true, closed: await closePrTabs(pr.key) });
        }
        case 'UNHIDE_PR': {
          await unhidePrs([msg.key]);
          const index = await readIndex();
          const pr = index.items.find((item) => item.key === msg.key);
          const parsed = pr ? parsePrUrl(pr.url) : null;
          // 一覧から消えた PR は印を外すだけ。開き直す一覧に載っていない
          if (!pr || !parsed) return sendResponse({ ok: true, opened: 0 });
          if ((await openPrKeys()).has(parsed.key)) return sendResponse({ ok: true, opened: 0 });

          const settings = await getSettings();
          const windowId = await currentWindowId(msg.windowId);
          const tabId = await createPrTab(pr.url, windowId);
          if (tabId == null) return sendResponse({ ok: true, opened: 0 });
          if (settings.enabled) {
            await addTabsToGroup([tabId], windowId, groupTitleFor(settings, parsed), settings);
          }
          return sendResponse({ ok: true, opened: 1 });
        }
        case 'DIAGNOSE': {
          const windowId = await currentWindowId(msg.windowId);
          return sendResponse(await diagnose(await activeTab(windowId)));
        }
        default:
          // ExtensionMessage を網羅しているので never。将来の追加漏れをここで気付ける
          return sendResponse({
            ok: false,
            error: `unknown message: ${(msg as { type?: string } | null)?.type}`,
          });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true; // 非同期レスポンス
});
