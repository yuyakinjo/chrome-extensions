import { getSettings, setSettings } from './lib/settings.js';
import { requestDeviceCode, pollForToken } from './lib/auth.js';
import { fetchViewer } from './lib/api.js';

const $ = (id) => document.getElementById(id);

/**
 * このページをタブとして開く理由:
 * ポップアップは GitHub のタブへ切り替えた瞬間に閉じて JS が止まる。Device Flow は
 * 承認されるまで数秒おきにポーリングし続ける必要があるので、独立したタブで走らせる。
 */

const show = (id) => {
  for (const s of ['setupStep', 'codeStep', 'doneStep']) $(s).hidden = s !== id;
};

function fail(message) {
  $('error').textContent = message;
  $('error').hidden = false;
}

const clearError = () => {
  $('error').hidden = true;
};

function renderScopeHint(includePrivate) {
  $('scopeHint').textContent = includePrivate
    ? '要求する権限: repo（private を含む PR の読み取り。GitHub の OAuth では書き込みと分けられません）'
    : '要求する権限: public_repo（public リポジトリのみ）';
}

let cancelled = false;

async function connect() {
  clearError();
  const clientId = $('clientId').value.trim();
  if (!clientId) return fail('Client ID を入力してください。');

  const includePrivate = $('includePrivate').checked;
  const scope = includePrivate ? 'repo' : 'public_repo';
  await setSettings({ clientId, authScope: scope });

  $('start').disabled = true;
  let device;
  try {
    device = await requestDeviceCode(clientId, scope);
  } catch (e) {
    $('start').disabled = false;
    return fail(e.message);
  }

  cancelled = false;
  show('codeStep');
  $('userCode').textContent = device.userCode;
  $('verifyLink').href = device.verifyUrl;
  $('fillNote').textContent = 'コードを入力しています…';

  // ポーリングを止めないよう await しない
  openVerifyTab(device).catch(() => {});

  try {
    const { token, scope: granted } = await pollForToken(device, (left) => {
      if (cancelled) throw new Error('キャンセルしました');
      const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      $('countdown').textContent = `承認を待っています… (残り ${mmss})`;
    });
    if (cancelled) return;
    await finish(token, granted);
  } catch (e) {
    if (cancelled) return;
    show('setupStep');
    $('start').disabled = false;
    fail(e.message);
  }
}

// ------------------------------------------------ GitHub の承認ページへコードを流し込む

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    return true;
  } catch {
    return false; // フォーカスが外れている等
  }
}

/**
 * GitHub の承認ページは入力欄が 1 文字ずつ 8 個に分かれていて、
 * ?user_code= を付けても埋まらない（2026 年時点の UI）。
 * そこでタブを開いたあとに、こちらから入力欄へ流し込む。
 * 失敗してもクリップボードにコピーしてあるので手で貼れる。
 */
async function openVerifyTab(device) {
  const copied = await copyCode(device.userCode); // タブを離れる前にコピーしておく
  const tab = await chrome.tabs.create({ url: device.verifyUrl, active: true });
  const how = await fillWhenReady(tab.id, device.userCode);

  $('fillNote').textContent =
    how === 'none'
      ? copied
        ? 'コードは自動入力できませんでした。GitHub のタブで ⌘V を押してください（コピー済みです）'
        : 'コードは自動入力できませんでした。上のコードを入力してください。'
      : 'コードを入力しました。GitHub のタブで Continue → Authorize を押してください。';
}

/** ページが組み上がるまで何度か試す。承認後の画面遷移でも呼ばれるので、成功するまで待つ。 */
function fillWhenReady(tabId, code) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (how) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve(how);
    };

    // MAIN を先に試す: ページと同じ JS コンテキストなので、React が value を
    // 握っている場合でも入力として認識される。未対応の Chrome では例外になるだけ。
    const attempt = async () => {
      for (const world of ['MAIN', 'ISOLATED']) {
        const [res] = await chrome.scripting
          .executeScript({ target: { tabId }, world, func: fillUserCode, args: [code] })
          .catch(() => []);
        if (res?.result && res.result !== 'none') return done(res.result);
      }
    };

    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') attempt();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    attempt(); // 既に読み込み終わっている場合
    setTimeout(() => done('none'), 10000);
  });
}

/**
 * 承認ページで実行される。executeScript で送られるので外の変数は参照できない。
 * 戻り値は使った手段（'paste' | 'boxes' | 'single' | 'none'）。
 */
async function fillUserCode(code) {
  const chars = code.replace(/[^0-9A-Za-z]/g, '').toUpperCase().split('');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // React などが value を握っている場合、代入だけでは反映されない
  const nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const set = (el, value) => {
    nativeSet.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const visible = () =>
    [...document.querySelectorAll('input')].filter(
      (el) => !el.disabled && !el.readOnly && el.type !== 'hidden' && el.offsetParent !== null
    );

  const boxes = () => {
    const all = visible();
    const single = all.filter((el) => el.maxLength === 1);
    if (single.length >= chars.length) return single.slice(0, chars.length);
    return all.length === chars.length ? all : []; // maxlength が付いていない UI
  };

  for (let i = 0; i < 30; i++) {
    if (boxes().length || document.querySelector('input[name="user_code"]')) break;
    await wait(100);
  }

  const one = document.querySelector('input[name="user_code"]');
  if (one) {
    set(one, code);
    one.focus();
    return 'single';
  }

  const els = boxes();
  if (!els.length) return 'none';
  const filled = () => els.every((el, i) => el.value.toUpperCase() === chars[i]);

  // まずは貼り付けハンドラに任せる。分割入力 UI はこれを想定して作られていることが多い
  els[0].focus();
  const dt = new DataTransfer();
  dt.setData('text/plain', code);
  els[0].dispatchEvent(new ClipboardEvent('paste', { bubbles: true, clipboardData: dt }));
  await wait(150);
  if (filled()) return 'paste';

  els.forEach((el, i) => set(el, chars[i] ?? ''));
  return filled() ? 'boxes' : 'none';
}

async function finish(token, grantedScope) {
  const login = await fetchViewer(token);
  if (!login) {
    show('setupStep');
    $('start').disabled = false;
    return fail('トークンは取得できましたが、ユーザー情報を読めませんでした。');
  }

  const before = await getSettings();
  // トークンの持ち主が本人なので、判定に使う ID もこれに合わせる
  await setSettings({ token, tokenSource: 'device', authLogin: login, username: login });

  show('doneStep');
  $('doneLogin').textContent = login;
  const notes = [`権限: ${grantedScope || '(不明)'}`];
  if (before.username && before.username !== login) {
    notes.push(`「自分の ID」を ${before.username} から ${login} に変更しました`);
  }
  $('doneNote').textContent = notes.join(' / ');

  // 接続直後に一度取得して、閉じたときには一覧が埋まっている状態にする
  chrome.runtime.sendMessage({ type: 'SYNC_NOW' }).catch(() => {});
}

async function init() {
  const s = await getSettings();
  $('clientId').value = s.clientId;
  $('includePrivate').checked = s.authScope !== 'public_repo';
  renderScopeHint($('includePrivate').checked);
  if (!s.clientId) $('howto').open = true;

  $('includePrivate').addEventListener('change', () =>
    renderScopeHint($('includePrivate').checked)
  );
  $('start').addEventListener('click', connect);
  $('clientId').addEventListener('keydown', (e) => e.key === 'Enter' && connect());

  $('copy').addEventListener('click', async () => {
    const ok = await copyCode($('userCode').textContent);
    $('copy').textContent = ok ? 'コピーしました' : '手動でコピーしてください';
    if (ok) setTimeout(() => ($('copy').textContent = 'コピー'), 1500);
  });

  $('cancel').addEventListener('click', () => {
    cancelled = true;
    show('setupStep');
    $('start').disabled = false;
  });

  $('close').addEventListener('click', () => window.close());
}

init().catch((e) => fail(e.message));
