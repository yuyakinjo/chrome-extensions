import { getSettings, setSettings, TAB_GROUP_COLORS } from './lib/settings.js';
import { needsAttention } from './lib/api.js';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');

const COLOR_LABELS = {
  grey: 'グレー',
  blue: 'ブルー',
  red: 'レッド',
  yellow: 'イエロー',
  green: 'グリーン',
  pink: 'ピンク',
  purple: 'パープル',
  cyan: 'シアン',
  orange: 'オレンジ',
};

const SOURCE_LABELS = {
  settings: '設定の ID',
  poll: '定期取得',
  title: 'タブのタイトル',
  page: 'ページの DOM',
  probe: 'ページの DOM（再読み取り）',
  cache: 'キャッシュ',
  session: '記憶したログイン名',
  api: 'GitHub API',
};

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

async function send(message) {
  const windowId = (await chrome.windows.getCurrent()).id;
  const res = await chrome.runtime.sendMessage({ ...message, windowId });
  if (!res?.ok) throw new Error(res?.error || '不明なエラー');
  return res;
}

const withBusy = (id, working, fn) => async () => {
  const btn = $(id);
  btn.disabled = true;
  setStatus(working);
  try {
    setStatus(await fn());
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    btn.disabled = false;
  }
};

function syncVisibility() {
  $('titleRow').classList.toggle('hidden', $('grouping').value === 'repo');
  const off = !$('poll').checked;
  for (const id of ['intervalRow', 'autoGroupOnPoll', 'notify', 'badge']) {
    $(id).closest('.row, .check').classList.toggle('dim', off);
  }
}

// ------------------------------------------------------------------ PR 一覧

function relative(ts) {
  if (!ts) return 'まだ取得していません';
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec} 秒前に更新`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分前に更新`;
  return `${Math.round(sec / 3600)} 時間前に更新`;
}

/** 行に出すラベル。要対応を優先して最大 2 つまで。 */
function badgesFor(pr) {
  const out = [];
  if (pr.mergeable === 'CONFLICTING') out.push(['コンフリクト', 'bad']);
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') out.push(['CI 失敗', 'bad']);
  if (pr.reviewDecision === 'CHANGES_REQUESTED') out.push(['要修正', 'bad']);
  if (pr.reviewDecision === 'APPROVED') out.push(['承認', 'good']);
  if (pr.isDraft) out.push(['Draft', 'muted']);
  if (pr.checks === 'PENDING') out.push(['CI 実行中', 'warn']);
  if (!out.length) out.push(['レビュー待ち', 'muted']);
  return out.slice(0, 2);
}

function renderPrs(index) {
  const list = $('prList');
  list.textContent = '';
  $('prCount').textContent = index.items?.length ? ` (${index.items.length})` : '';

  const meta = [];
  if (index.error) meta.push(`⚠ ${index.error}`);
  else if (index.needsAuth) meta.push('未接続');
  else meta.push(relative(index.fetchedAt));
  if (index.degraded) meta.push('※ GraphQL が使えないため状態は取得できていません');
  $('prMeta').textContent = meta.join(' / ');

  if (!index.items?.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = index.needsAuth
      ? 'GitHub と接続すると、ここに自分の PR が並びます'
      : index.error
        ? '取得できませんでした'
        : 'オープンな PR はありません';
    list.append(li);
    return;
  }

  for (const pr of index.items) {
    const li = document.createElement('li');
    li.className = needsAttention(pr) ? 'pr attention' : 'pr';

    const btn = document.createElement('button');
    btn.className = 'prLink';
    btn.title = pr.url;

    const line1 = Object.assign(document.createElement('span'), {
      className: 'prTitle',
      textContent: pr.title,
    });
    const line2 = Object.assign(document.createElement('span'), { className: 'prSub' });
    line2.append(
      Object.assign(document.createElement('span'), {
        className: 'prRepo',
        textContent: `${pr.nwo} #${pr.number}`,
      })
    );
    for (const [text, kind] of badgesFor(pr)) {
      line2.append(Object.assign(document.createElement('span'), { className: `tag ${kind}`, textContent: text }));
    }

    btn.append(line1, line2);
    btn.addEventListener('click', () => {
      send({ type: 'OPEN_PR', url: pr.url }).then(() => window.close());
    });
    li.append(btn);
    list.append(li);
  }
}

const refresh = withBusy('refresh', '取得しています…', async () => {
  const index = await send({ type: 'SYNC_NOW' });
  renderPrs(index); // エラーでも前回の一覧は残っているので先に描く
  if (index.error) throw new Error(index.error);
  return '更新しました';
});

// ------------------------------------------------------------------ 判定結果

const src = (s) => (s ? `（${SOURCE_LABELS[s] || s}）` : '');

async function renderDiagnostics() {
  const dl = $('diag');
  dl.textContent = '';

  let d;
  try {
    d = await send({ type: 'DIAGNOSE' });
  } catch (e) {
    dl.append(Object.assign(document.createElement('dd'), { textContent: e.message }));
    return;
  }

  const rows = !d.isPr
    ? [['このタブ', 'PR ページではありません']]
    : [
        ['PR', d.prKey],
        ['作者', d.author ? `${d.author} ${src(d.authorSource)}` : '取得できませんでした'],
        ['自分の ID', d.viewer ? `${d.viewer} ${src(d.viewerSource)}` : '未設定'],
        ['判定', d.mine ? '自分の PR' : '自分の PR ではない'],
        ['入れる先', d.groupTitle],
        ['現在', d.groupId > -1 ? 'グループ内' : 'グループ外'],
      ];

  rows.push([
    '定期取得',
    d.poll
      ? `${d.poll.periodInMinutes} 分ごと（次回 ${new Date(d.poll.nextAt).toLocaleTimeString('ja-JP')}）`
      : '停止中',
  ]);

  for (const [k, v] of rows) {
    dl.append(
      Object.assign(document.createElement('dt'), { textContent: k }),
      Object.assign(document.createElement('dd'), { textContent: String(v ?? '-') })
    );
  }
}

function renderPollStatus(s) {
  $('pollStatus').textContent = !s.token
    ? '⚠ GitHub と未接続のため停止しています'
    : s.poll
      ? `${s.pollMinutes} 分ごとに取得します`
      : '停止中';
}

function renderAccount(s) {
  const connected = !!s.token;
  $('accountState').textContent = !connected
    ? '未接続です。接続すると自分の PR を自動で取得できます。'
    : s.tokenSource === 'device'
      ? `${s.authLogin || '?'} として接続中（ブラウザ認証）`
      : 'Personal Access Token で設定済み';
  $('signIn').textContent = connected ? '接続し直す' : 'GitHub で接続する';
  $('signOut').classList.toggle('hidden', !connected);
  $('patBox').classList.toggle('hidden', connected);
  renderPollStatus(s);
}

// ------------------------------------------------------------------ 起動

async function init() {
  $('color').append(...TAB_GROUP_COLORS.map((c) => new Option(COLOR_LABELS[c] || c, c)));

  const s = await getSettings();
  for (const id of ['enabled', 'onlyMine', 'gatherOnCreate', 'collapse', 'poll', 'badge', 'notify', 'autoGroupOnPoll']) {
    $(id).checked = s[id];
  }
  $('grouping').value = s.grouping;
  $('groupTitle').value = s.groupTitle;
  $('username').value = s.username;
  $('color').value = s.color;
  $('pollMinutes').value = s.pollMinutes;
  $('token').value = s.token ? '••••••••••••' : '';
  syncVisibility();
  renderAccount(s);
  if (!s.token) $('accountBox').open = true;

  // 保存済みの一覧をまず出して、開くたびに裏で取り直す
  if (!s.token) {
    renderPrs({ items: [], needsAuth: true });
  } else {
    renderPrs(await send({ type: 'GET_PRS' }));
    send({ type: 'SYNC_NOW' })
      .then((index) => {
        renderPrs(index);
        if (index.needsAuth) setStatus('GitHub と接続し直してください', true);
      })
      .catch(() => {});
  }

  const bind = (id, prop = 'checked', after) =>
    $(id).addEventListener('change', async () => {
      const next = await setSettings({ [id]: $(id)[prop] });
      setStatus('保存しました');
      after?.(next);
    });

  bind('enabled');
  bind('onlyMine');
  bind('gatherOnCreate');
  bind('collapse');
  bind('badge', 'checked', renderPollStatus);
  bind('notify');
  bind('autoGroupOnPoll');
  bind('color', 'value');
  bind('groupTitle', 'value');
  bind('username', 'value', () => renderDiagnostics());

  $('poll').addEventListener('change', async () => {
    renderPollStatus(await setSettings({ poll: $('poll').checked }));
    syncVisibility();
    setStatus('保存しました');
  });

  $('pollMinutes').addEventListener('change', async () => {
    const minutes = Math.min(60, Math.max(1, Math.round(Number($('pollMinutes').value) || 1)));
    $('pollMinutes').value = minutes;
    renderPollStatus(await setSettings({ pollMinutes: minutes }));
    setStatus('保存しました');
  });

  $('grouping').addEventListener('change', async () => {
    await setSettings({ grouping: $('grouping').value });
    syncVisibility();
    setStatus('保存しました');
  });

  $('saveToken').addEventListener('click', async () => {
    const value = $('token').value.trim();
    if (!value || value.startsWith('•')) return setStatus('トークンが入力されていません', true);
    renderAccount(await setSettings({ token: value, tokenSource: 'pat', authLogin: '' }));
    $('token').value = '••••••••••••';
    setStatus('トークンを保存しました');
    refresh();
  });

  // 認証は独立したタブで行う。ポップアップは GitHub に切り替えた時点で閉じてしまうため
  $('signIn').addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/auth.html') });
    window.close();
  });

  $('signOut').addEventListener('click', async () => {
    renderAccount(await setSettings({ token: '', tokenSource: '', authLogin: '' }));
    renderPrs({ items: [], needsAuth: true });
    setStatus('接続を解除しました。GitHub 側の認可は Authorized OAuth Apps から取り消せます');
  });

  $('refresh').addEventListener('click', refresh);

  $('gather').addEventListener(
    'click',
    withBusy('gather', 'まとめています…', async () => {
      const res = await send({ type: 'GATHER_OPEN' });
      return res.grouped
        ? `${res.grouped} 個のタブを ${res.groups} グループにまとめました`
        : '対象の PR タブが見つかりませんでした';
    })
  );

  $('regroup').addEventListener(
    'click',
    withBusy('regroup', 'グループに入れています…', async () => {
      const res = await send({ type: 'REGROUP_ACTIVE' });
      renderDiagnostics();
      return `「${res.groupTitle}」に入れました`;
    })
  );

  $('openMine').addEventListener(
    'click',
    withBusy('openMine', 'GitHub から取得しています…', async () => {
      const res = await send({ type: 'OPEN_MY_PRS' });
      return `${res.opened} 件を開き、合計 ${res.grouped} タブをまとめました`;
    })
  );

  $('diagBox').addEventListener('toggle', () => {
    if ($('diagBox').open) renderDiagnostics();
  });
}

init().catch((e) => setStatus(e.message, true));
