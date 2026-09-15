import {
  parsePrUrl,
  isComparePage,
  canonicalPrUrl,
  authorFromTitle,
  sameUser,
  GITHUB_HOST,
} from './lib/github.js';
import { getSettings } from './lib/settings.js';
import { readCache, rememberPr } from './lib/cache.js';
import { fetchViewer, fetchPrAuthor } from './lib/api.js';
import { ALARM, syncMyPrs, rescheduleSync, readIndex } from './lib/sync.js';

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

const comparedKey = (tabId) => `cmp:${tabId}`;
const createdKey = (tabId) => `new:${tabId}`;

/** 消さずに確認する。判定できずグループ化しなかったときにフラグを失わないため。 */
async function peekJustCreated(tabId, prKey) {
  const got = await chrome.storage.session.get(createdKey(tabId));
  return got[createdKey(tabId)] === prKey;
}

const consumeJustCreated = (tabId) => chrome.storage.session.remove(createdKey(tabId));

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([comparedKey(tabId), createdKey(tabId)]);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    if (isComparePage(changeInfo.url)) {
      await chrome.storage.session.set({ [comparedKey(tabId)]: Date.now() });
    } else if (parsePrUrl(changeInfo.url)) {
      const flag = await chrome.storage.session.get(comparedKey(tabId));
      if (flag[comparedKey(tabId)]) {
        await chrome.storage.session.set({ [createdKey(tabId)]: parsePrUrl(changeInfo.url).key });
        await chrome.storage.session.remove(comparedKey(tabId));
      }
    }
  }

  // タイトルは URL より少し遅れて決まるので、title / complete の両方で判定し直す
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    await evaluateAndGroup(tab).catch(() => {});
  }
});

// ---------------------------------------------------------- 定期取得のライフサイクル

// service worker は常駐しないので、リスナーは必ずトップレベルで登録する
async function startPolling() {
  const { scheduled } = await rescheduleSync();
  // 初回は通知を出さない（既存の状態を「変化」として全部知らせてしまうため）
  if (scheduled) await syncMyPrs({ silent: true }).catch(() => {});
}

/**
 * 拡張機能をリロード／更新すると、既に開いているタブの content script は
 * 無効化されたまま残る（chrome.runtime が消え、通知が届かなくなる）。
 * タブを 1 枚ずつ再読み込みさせずに済むよう、こちらから入れ直す。
 */
async function reinjectContentScripts() {
  const tabs = await chrome.tabs.query({ url: `https://${GITHUB_HOST}/*` });
  await Promise.all(
    tabs.map((tab) =>
      chrome.scripting
        .executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES })
        .catch(() => {}) // 既に別ページへ遷移した、権限がないなど
    )
  );
}

chrome.runtime.onInstalled.addListener(() => {
  startPolling().catch(() => {});
  reinjectContentScripts().catch(() => {});
});
chrome.runtime.onStartup.addListener(startPolling);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== ALARM) return;
  (async () => {
    await syncMyPrs();
    const settings = await getSettings();
    if (!settings.autoGroupOnPoll || !settings.enabled) return;
    // 取得のたびにまとめ直す。既定は OFF（手で外したタブを勝手に戻さないため）
    const { id } = await chrome.windows.getLastFocused();
    await gatherPrTabs(id, settings);
  })().catch(() => {});
});

// 設定が変わったら張り直す。ポップアップからでも options からでも効くようにここで見る
const SCHEDULE_KEYS = ['poll', 'pollMinutes', 'token'];
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const { oldValue = {}, newValue = {} } = changes.settings;
  if (SCHEDULE_KEYS.some((k) => oldValue[k] !== newValue[k])) {
    await rescheduleSync();
    if (newValue.poll && newValue.token) await syncMyPrs({ silent: true }).catch(() => {});
  }
});

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('pr|')) return;
  chrome.notifications.clear(id);
  await openOrFocus(id.slice(3));
});

// ------------------------------------------------------------ グループ操作

function groupTitleFor(settings, pr) {
  return settings.grouping === 'repo' ? pr.nwo : settings.groupTitle || 'My PRs';
}

/** 同じウィンドウに同名グループがあれば使い回し、なければ作る。 */
async function addTabsToGroup(tabIds, windowId, title, settings) {
  if (!tabIds.length) return null;

  const existing = (await chrome.tabGroups.query({ windowId })).find((g) => g.title === title);

  if (existing) {
    const targets = [];
    for (const id of tabIds) {
      const tab = await chrome.tabs.get(id).catch(() => null);
      if (tab && tab.groupId !== existing.id) targets.push(id);
    }
    if (!targets.length) return existing.id;
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

/** 既に開いていればそのタブへ、なければ新しいタブで開く。 */
async function openOrFocus(url, windowId) {
  const target = parsePrUrl(url);
  const tabs = await chrome.tabs.query({});
  const hit = tabs.find((t) => {
    const p = parsePrUrl(t.url || t.pendingUrl || '');
    return p && target && p.key === target.key;
  });

  if (hit) {
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
async function probeTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [EXTRACT_FILE] });
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => globalThis.__prTabGrouper?.snapshot() ?? null,
    });
    return res?.result || null;
  } catch {
    return null; // 権限のないページ、まだ読み込み中など
  }
}

// ------------------------------------------------------- 自分の PR かどうかの判定

/** 設定のユーザー名を最優先。次に定期取得の結果、ページの meta、最後に API。 */
async function resolveViewer(settings, hint) {
  const configured = settings.username?.trim();
  if (configured) return { viewer: configured, viewerSource: 'settings' };

  const { viewer: fromIndex } = await readIndex();
  if (fromIndex) return { viewer: fromIndex, viewerSource: 'poll' };

  if (hint?.viewer) {
    await chrome.storage.session.set({ viewer: hint.viewer });
    return { viewer: hint.viewer, viewerSource: 'page' };
  }

  const cached = (await chrome.storage.session.get('viewer')).viewer;
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

/** deep=true のときだけページ再注入 / API まで踏み込む。 */
async function resolveAuthor(tab, pr, hint, settings, cache, deep) {
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

  const snap = await probeTab(tab.id);
  if (snap?.author) return { author: snap.author, authorSource: 'probe', viewer: snap.viewer };

  if (settings.token) {
    const author = await fetchPrAuthor(pr, settings.token);
    if (author) return { author, authorSource: 'api' };
  }
  return { author: null, authorSource: null };
}

/** 1 つのタブについて「自分の PR か」を判定する（グループ化はしない）。 */
async function classifyTab(tab, hint = {}, { deep = false, cache = null } = {}) {
  const settings = await getSettings();
  const pr = parsePrUrl(tab?.url || tab?.pendingUrl || '');
  if (!pr) return { pr: null, settings };

  const prCache = cache ?? (await readCache());
  const a = await resolveAuthor(tab, pr, hint, settings, prCache, deep);
  const v = await resolveViewer(settings, { viewer: hint.viewer || a.viewer });

  const justCreated = hint.justCreated || (await peekJustCreated(tab.id, pr.key));
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

/** 判定してグループ化まで行う。onUpdated と content script の両方から呼ばれる。 */
async function evaluateAndGroup(tab, hint = {}) {
  if (!tab || tab.incognito || tab.pinned) return { ok: false, reason: 'skip-tab' };

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
async function gatherPrTabs(windowId, settings) {
  const [tabs, cache] = await Promise.all([chrome.tabs.query({ windowId }), readCache()]);

  const buckets = new Map();
  for (const tab of tabs) {
    if (tab.pinned) continue;
    const c = await classifyTab(tab, {}, { deep: true, cache });
    if (!c.pr) continue;
    if (c.author && c.viewer) cache[c.pr.key] = { ...cache[c.pr.key], author: c.author, mine: c.mine };
    if (settings.onlyMine && !c.mine) continue;

    const title = groupTitleFor(settings, c.pr);
    if (!buckets.has(title)) buckets.set(title, []);
    buckets.get(title).push(tab.id);
  }

  let grouped = 0;
  for (const [title, tabIds] of buckets) {
    await addTabsToGroup(tabIds, windowId, title, settings);
    grouped += tabIds.length;
  }
  return { grouped, groups: buckets.size };
}

/** 自分のオープン PR をまとめて開いてグループ化する。 */
async function openMyPrs(windowId) {
  const settings = await getSettings();
  if (!settings.token) throw new Error('Personal Access Token が未設定です');

  // 定期取得の結果をそのまま使う。古ければ取り直す
  let index = await readIndex();
  if (!index.fetchedAt || Date.now() - index.fetchedAt > 60_000) index = await syncMyPrs({ silent: true });
  if (index.error && !index.items.length) throw new Error(index.error);
  if (!index.items.length) return { opened: 0, grouped: 0, groups: 0 };

  const tabs = await chrome.tabs.query({ windowId });
  const already = new Set(
    tabs
      .map((t) => parsePrUrl(t.url || t.pendingUrl || ''))
      .filter(Boolean)
      .map((p) => p.key)
  );

  let opened = 0;
  for (const pr of index.items) {
    const parsed = parsePrUrl(pr.url);
    if (!parsed || already.has(parsed.key)) continue;
    await chrome.tabs.create({ url: pr.url, windowId, active: false });
    opened++;
  }

  return { opened, ...(await gatherPrTabs(windowId, settings)) };
}

/** ポップアップの「判定結果」表示用。なぜグループ化されないのかを可視化する。 */
async function diagnose(tab) {
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
      ? { periodInMinutes: alarm.periodInMinutes, nextAt: alarm.scheduledTime }
      : null,
    index: { count: index.items.length, fetchedAt: index.fetchedAt, error: index.error },
  };
}

// ------------------------------------------------------------ メッセージ処理

const currentWindowId = async (given) => given ?? (await chrome.windows.getLastFocused()).id;
const activeTab = async (windowId) =>
  (await chrome.tabs.query({ active: true, windowId }))[0] ?? null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'PR_PAGE': {
          if (!sender.tab) return sendResponse({ ok: false, reason: 'no-tab' });
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
          await addTabsToGroup([tab.id], tab.windowId, groupTitleFor(c.settings, c.pr), c.settings);
          await rememberPr(c.pr.key, { author: c.author, mine: true, url: canonicalPrUrl(c.pr) });
          return sendResponse({ ok: true, groupTitle: groupTitleFor(c.settings, c.pr) });
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
        case 'DIAGNOSE': {
          const windowId = await currentWindowId(msg.windowId);
          return sendResponse(await diagnose(await activeTab(windowId)));
        }
        default:
          return sendResponse({ ok: false, error: `unknown message: ${msg?.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // 非同期レスポンス
});
