import { getSettings, setSettings, TAB_GROUP_COLORS } from './lib/settings.js';
import { needsAttention } from './lib/api.js';
import { readHidden } from './lib/hidden.js';
import type {
  AuthorSource,
  MessageResponse,
  MessageResults,
  PopupMessage,
  PrIndex,
  PrItem,
  Settings,
  TabGroupColor,
  ViewerSource,
} from './lib/types.js';

/** popup.html にある要素。id を間違えたらここで型エラーになる。 */
interface PopupElements {
  enabled: HTMLInputElement;
  onlyMine: HTMLInputElement;
  gatherOnCreate: HTMLInputElement;
  collapse: HTMLInputElement;
  poll: HTMLInputElement;
  badge: HTMLInputElement;
  notify: HTMLInputElement;
  autoOpenOnPoll: HTMLInputElement;
  closeMergedOnPoll: HTMLInputElement;
  autoGroupOnPoll: HTMLInputElement;
  username: HTMLInputElement;
  groupTitle: HTMLInputElement;
  pollMinutes: HTMLInputElement;
  token: HTMLInputElement;
  grouping: HTMLSelectElement;
  color: HTMLSelectElement;
  refresh: HTMLButtonElement;
  gather: HTMLButtonElement;
  regroup: HTMLButtonElement;
  openMine: HTMLButtonElement;
  pruneClosed: HTMLButtonElement;
  signIn: HTMLButtonElement;
  signOut: HTMLButtonElement;
  saveToken: HTMLButtonElement;
  pollBox: HTMLDetailsElement;
  diagBox: HTMLDetailsElement;
  accountBox: HTMLDetailsElement;
  patBox: HTMLDetailsElement;
  prList: HTMLUListElement;
  diag: HTMLDListElement;
  prsSection: HTMLElement;
  prCount: HTMLSpanElement;
  prMeta: HTMLParagraphElement;
  pollStatus: HTMLParagraphElement;
  accountState: HTMLParagraphElement;
  status: HTMLParagraphElement;
  titleRow: HTMLDivElement;
  intervalRow: HTMLDivElement;
}

function $<K extends keyof PopupElements>(id: K): PopupElements[K] {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} が popup.html にありません`);
  return el as PopupElements[K];
}

const COLOR_LABELS: Record<TabGroupColor, string> = {
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

const SOURCE_LABELS: Record<AuthorSource | ViewerSource, string> = {
  settings: '設定の ID',
  poll: '定期取得',
  title: 'タブのタイトル',
  page: 'ページの DOM',
  probe: 'ページの DOM（再読み取り）',
  cache: 'キャッシュ',
  session: '記憶したログイン名',
  api: 'GitHub API',
};

function setStatus(text: string, isError = false): void {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

/** background へ問い合わせる。windowId は毎回こちらで足す。 */
async function send<K extends PopupMessage['type']>(
  message: Extract<PopupMessage, { type: K }>
): Promise<MessageResults[K]> {
  const windowId = (await chrome.windows.getCurrent()).id;
  const res: MessageResponse | undefined = await chrome.runtime.sendMessage({
    ...message,
    windowId,
  });
  if (!res?.ok) throw new Error(res?.error || '不明なエラー');
  return res as unknown as MessageResults[K];
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 押している間だけボタンを止めて、返ってきた文字列をステータスに出す。 */
type ButtonId = {
  [K in keyof PopupElements]: PopupElements[K] extends HTMLButtonElement ? K : never;
}[keyof PopupElements];

const withBusy = (id: ButtonId, working: string, fn: () => Promise<string>) => async () => {
  const btn = $(id);
  btn.disabled = true;
  setStatus(working);
  try {
    setStatus(await fn());
  } catch (e) {
    setStatus(message(e), true);
  } finally {
    btn.disabled = false;
  }
};

function syncVisibility(): void {
  $('titleRow').classList.toggle('hidden', $('grouping').value === 'repo');
  const off = !$('poll').checked;
  for (const id of [
    'intervalRow',
    'autoOpenOnPoll',
    'closeMergedOnPoll',
    'autoGroupOnPoll',
    'notify',
    'badge',
  ] as const) {
    $(id).closest('.row, .check')?.classList.toggle('dim', off);
  }
}

// ------------------------------------------------------------------ PR 一覧

function relative(ts: number | null | undefined): string {
  if (!ts) return 'まだ取得していません';
  const sec = Math.round((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec} 秒前に更新`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分前に更新`;
  return `${Math.round(sec / 3600)} 時間前に更新`;
}

type BadgeKind = 'bad' | 'good' | 'warn' | 'muted';

/** 行に出すラベル。要対応を優先して最大 2 つまで。 */
function badgesFor(pr: PrItem): Array<[string, BadgeKind]> {
  const out: Array<[string, BadgeKind]> = [];
  if (pr.mergeable === 'CONFLICTING') out.push(['コンフリクト', 'bad']);
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') out.push(['CI 失敗', 'bad']);
  if (pr.reviewDecision === 'CHANGES_REQUESTED') out.push(['要修正', 'bad']);
  if (pr.reviewDecision === 'APPROVED') out.push(['承認', 'good']);
  if (pr.isDraft) out.push(['Draft', 'muted']);
  if (pr.checks === 'PENDING') out.push(['CI 実行中', 'warn']);
  if (!out.length) out.push(['レビュー待ち', 'muted']);
  return out.slice(0, 2);
}

/** 非表示にする／戻すボタン。押している間だけ止めて、終わったら一覧を描き直す。 */
function hideToggle(pr: PrItem, isHidden: boolean, redraw: () => void): HTMLButtonElement {
  const btn = Object.assign(document.createElement('button'), {
    className: 'prHide link',
    textContent: isHidden ? '戻す' : '非表示',
    title: isHidden
      ? 'タブを開き直して、また自動で開くようにします'
      : 'タブを閉じて、定期取得でも開き直さないようにします',
  });

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      if (isHidden) {
        const res = await send({ type: 'UNHIDE_PR', key: pr.key });
        setStatus(res.opened ? 'タブを開き直しました' : '非表示を解除しました');
      } else {
        const res = await send({ type: 'HIDE_PR', key: pr.key });
        setStatus(res.closed ? '非表示にしてタブを閉じました' : '非表示にしました');
      }
      redraw();
    } catch (e) {
      setStatus(message(e), true);
    } finally {
      btn.disabled = false;
    }
  });
  return btn;
}

/** 未接続のときは items だけを渡すので、一覧はどのフィールドも欠けうる。 */
async function renderPrs(index: Partial<PrIndex>): Promise<void> {
  const list = $('prList');
  list.textContent = '';

  const hidden = await readHidden();
  const items = index.items ?? [];
  const hiddenCount = items.filter((pr) => hidden[pr.key]).length;
  $('prCount').textContent = items.length
    ? ` (${items.length}${hiddenCount ? ` / 非表示 ${hiddenCount}` : ''})`
    : '';

  const meta: string[] = [];
  if (index.error) meta.push(`⚠ ${index.error}`);
  else if (index.needsAuth) meta.push('未接続');
  else meta.push(relative(index.fetchedAt));
  if (index.degraded) meta.push('※ GraphQL が使えないため状態は取得できていません');
  $('prMeta').textContent = meta.join(' / ');

  if (!items.length) {
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

  const redraw = () => void renderPrs(index);
  // 非表示にしたものは下にまとめる（同じ並び順のまま後ろへ回す）
  const ordered = [...items].sort((a, b) => Number(!!hidden[a.key]) - Number(!!hidden[b.key]));

  for (const pr of ordered) {
    const isHidden = !!hidden[pr.key];
    const li = document.createElement('li');
    li.className = `pr${needsAttention(pr) ? ' attention' : ''}${isHidden ? ' hiddenPr' : ''}`;

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
    const badges: Array<[string, BadgeKind]> = isHidden
      ? [['非表示', 'muted'], ...badgesFor(pr)]
      : badgesFor(pr);
    for (const [text, kind] of badges) {
      line2.append(
        Object.assign(document.createElement('span'), { className: `tag ${kind}`, textContent: text })
      );
    }

    btn.append(line1, line2);
    btn.addEventListener('click', () => {
      send({ type: 'OPEN_PR', url: pr.url }).then(() => window.close());
    });
    li.append(btn, hideToggle(pr, isHidden, redraw));
    list.append(li);
  }
}

const refresh = withBusy('refresh', '取得しています…', async () => {
  const index = await send({ type: 'SYNC_NOW' });
  await renderPrs(index); // エラーでも前回の一覧は残っているので先に描く
  if (index.error) throw new Error(index.error);
  return '更新しました';
});

// ------------------------------------------------------------------ 判定結果

const src = (s: AuthorSource | ViewerSource | null | undefined): string =>
  s ? `（${SOURCE_LABELS[s] || s}）` : '';

async function renderDiagnostics(): Promise<void> {
  const dl = $('diag');
  dl.textContent = '';

  let d;
  try {
    d = await send({ type: 'DIAGNOSE' });
  } catch (e) {
    dl.append(Object.assign(document.createElement('dd'), { textContent: message(e) }));
    return;
  }

  const rows: Array<[string, string | number | null | undefined]> = !d.isPr
    ? [['このタブ', 'PR ページではありません']]
    : [
        ['PR', d.prKey],
        ['作者', d.author ? `${d.author} ${src(d.authorSource)}` : '取得できませんでした'],
        ['自分の ID', d.viewer ? `${d.viewer} ${src(d.viewerSource)}` : '未設定'],
        ['判定', d.mine ? '自分の PR' : '自分の PR ではない'],
        ['入れる先', d.groupTitle],
        ['現在', (d.groupId ?? -1) > -1 ? 'グループ内' : 'グループ外'],
      ];

  rows.push([
    '定期取得',
    d.poll
      ? `${d.poll.periodInMinutes} 分ごと（次回 ${new Date(d.poll.nextAt).toLocaleTimeString('ja-JP')}）` +
        (d.poll.autoOpen ? ' / 未オープンの PR を開く' : '')
      : '停止中',
  ]);

  for (const [k, v] of rows) {
    dl.append(
      Object.assign(document.createElement('dt'), { textContent: k }),
      Object.assign(document.createElement('dd'), { textContent: String(v ?? '-') })
    );
  }
}

function renderPollStatus(s: Settings): void {
  $('pollStatus').textContent = !s.token
    ? '⚠ GitHub と未接続のため停止しています'
    : !s.poll
      ? '停止中'
      : s.autoOpenOnPoll
        ? `${s.pollMinutes} 分ごとに取得して、未オープンの PR をタブで開きます`
        : `${s.pollMinutes} 分ごとに取得します`;
}

function renderAccount(s: Settings): void {
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

/** チェックボックスで切り替える設定。Settings 側で真偽値のものだけ。 */
type CheckId = Extract<
  { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings],
  keyof PopupElements
>;

const CHECK_IDS = [
  'enabled',
  'onlyMine',
  'gatherOnCreate',
  'collapse',
  'poll',
  'badge',
  'notify',
  'autoOpenOnPoll',
  'closeMergedOnPoll',
  'autoGroupOnPoll',
] as const satisfies readonly CheckId[];

async function init(): Promise<void> {
  $('color').append(...TAB_GROUP_COLORS.map((c) => new Option(COLOR_LABELS[c] || c, c)));

  const s = await getSettings();
  for (const id of CHECK_IDS) $(id).checked = s[id];
  $('grouping').value = s.grouping;
  $('groupTitle').value = s.groupTitle;
  $('username').value = s.username;
  $('color').value = s.color;
  $('pollMinutes').value = String(s.pollMinutes);
  $('token').value = s.token ? '••••••••••••' : '';
  syncVisibility();
  renderAccount(s);
  if (!s.token) $('accountBox').open = true;

  // 保存済みの一覧をまず出して、開くたびに裏で取り直す
  if (!s.token) {
    await renderPrs({ items: [], needsAuth: true });
  } else {
    await renderPrs(await send({ type: 'GET_PRS' }));
    send({ type: 'SYNC_NOW' })
      .then((index) => {
        void renderPrs(index);
        if (index.needsAuth) setStatus('GitHub と接続し直してください', true);
      })
      .catch(() => {});
  }

  /** チェックボックスの設定。変更されたらそのまま保存する。 */
  const bindCheck = (id: CheckId, after?: (s: Settings) => void) =>
    $(id).addEventListener('change', async () => {
      const next = await setSettings({ [id]: $(id).checked } as Partial<Settings>);
      setStatus('保存しました');
      after?.(next);
    });

  /** 文字列を入れる設定。 */
  const bindValue = (id: 'color' | 'groupTitle' | 'username', after?: (s: Settings) => void) =>
    $(id).addEventListener('change', async () => {
      const next = await setSettings({ [id]: $(id).value } as Partial<Settings>);
      setStatus('保存しました');
      after?.(next);
    });

  bindCheck('enabled');
  bindCheck('onlyMine');
  bindCheck('gatherOnCreate');
  bindCheck('collapse');
  bindCheck('badge', renderPollStatus);
  bindCheck('notify');
  bindCheck('autoOpenOnPoll', renderPollStatus);
  bindCheck('closeMergedOnPoll');
  bindCheck('autoGroupOnPoll');
  bindValue('color');
  bindValue('groupTitle');
  bindValue('username', () => void renderDiagnostics());

  $('poll').addEventListener('change', async () => {
    renderPollStatus(await setSettings({ poll: $('poll').checked }));
    syncVisibility();
    setStatus('保存しました');
  });

  $('pollMinutes').addEventListener('change', async () => {
    const minutes = Math.min(60, Math.max(1, Math.round(Number($('pollMinutes').value) || 1)));
    $('pollMinutes').value = String(minutes);
    renderPollStatus(await setSettings({ pollMinutes: minutes }));
    setStatus('保存しました');
  });

  $('grouping').addEventListener('change', async () => {
    await setSettings({ grouping: $('grouping').value as Settings['grouping'] });
    syncVisibility();
    setStatus('保存しました');
  });

  $('saveToken').addEventListener('click', async () => {
    const value = $('token').value.trim();
    if (!value || value.startsWith('•')) return setStatus('トークンが入力されていません', true);
    renderAccount(await setSettings({ token: value, tokenSource: 'pat', authLogin: '' }));
    $('token').value = '••••••••••••';
    setStatus('トークンを保存しました');
    void refresh();
  });

  // 認証は独立したタブで行う。ポップアップは GitHub に切り替えた時点で閉じてしまうため
  $('signIn').addEventListener('click', async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL('src/auth.html') });
    window.close();
  });

  $('signOut').addEventListener('click', async () => {
    renderAccount(await setSettings({ token: '', tokenSource: '', authLogin: '' }));
    void renderPrs({ items: [], needsAuth: true });
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
      void renderDiagnostics();
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

  $('pruneClosed').addEventListener(
    'click',
    withBusy('pruneClosed', '状態を確認しています…', async () => {
      const res = await send({ type: 'PRUNE_CLOSED' });
      return res.closed
        ? `マージ・クローズ済みの ${res.closed} タブを閉じました`
        : '閉じる対象のタブはありませんでした';
    })
  );

  $('diagBox').addEventListener('toggle', () => {
    if ($('diagBox').open) void renderDiagnostics();
  });
}

init().catch((e: unknown) => setStatus(message(e), true));
