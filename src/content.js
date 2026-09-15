/**
 * github.com 上で「PR ページを開いた」ことを検知して service worker に通知する。
 * 実際の DOM 読み取りは lib/extract.js（先に読み込まれる）に任せる。
 *
 * GitHub は Turbo / React Router でソフトナビゲーションするため、
 * 初回ロードだけでなく URL の変化も監視する。
 *
 * 拡張機能をリロード／更新すると、既に開いているページに残ったこのスクリプトは
 * 「無効化されたコンテキスト」になり chrome.runtime ごと消える。にもかかわらず
 * タイマーとイベントリスナーは動き続けるので、気づいたら自分で後始末する。
 */

// 再注入されても壊れないよう、グローバルに識別子を漏らさない
(() => {
  const gh = globalThis.__prTabGrouper;
  const COMPARE_PATH_RE = /^\/[^/]+\/[^/]+\/compare(?:\/|$)/;

  // 同じページに新しいインスタンスが入ったときは、まず古いほうを止める
  globalThis.__prTabGrouperStop?.();

  let lastSent = null;
  let stopped = false;

  const timeouts = new Set();
  const intervals = new Set();
  const listeners = [];

  const later = (fn, ms) => {
    const id = setTimeout(() => {
      timeouts.delete(id);
      fn();
    }, ms);
    timeouts.add(id);
  };

  const every = (fn, ms) => intervals.add(setInterval(fn, ms));

  const on = (target, type, fn) => {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  };

  /** 拡張機能がリロード／無効化されると chrome.runtime へのアクセス自体が落ちる。 */
  function alive() {
    if (stopped) return false;
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false; // "Extension context invalidated"
    }
  }

  function stop() {
    stopped = true;
    for (const id of timeouts) clearTimeout(id);
    for (const id of intervals) clearInterval(id);
    timeouts.clear();
    intervals.clear();
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    listeners.length = 0;
    if (globalThis.__prTabGrouperStop === stop) delete globalThis.__prTabGrouperStop;
  }

  globalThis.__prTabGrouperStop = stop;

  /** 送信できたら true。作者がまだ読めていなければ false（呼び出し側がリトライする）。 */
  function report(justCreated) {
    const snap = gh.snapshot();
    if (!snap) return true; // PR ページではなくなった

    const sig = `${snap.url}|${snap.viewer}|${snap.author}|${justCreated}`;
    if (sig === lastSent) return true;
    if (!snap.author && !justCreated) return false;

    lastSent = sig;
    send({ ...snap, justCreated });
    return true;
  }

  function send(payload) {
    if (!alive()) return stop();
    try {
      chrome.runtime.sendMessage({ type: 'PR_PAGE', ...payload })?.catch(() => {
        // service worker の再起動中など。次の検知で送り直される。
      });
    } catch {
      stop(); // 送信しようとした瞬間に無効化された
    }
  }

  /** 描画途中のことがあるので、作者が読めるまで少しリトライする。 */
  function reportWithRetry(justCreated) {
    let attempt = 0;
    const tick = () => {
      if (!alive()) return stop();
      if (!gh.isPrPage()) return;
      if (report(justCreated)) return;
      if (++attempt >= 12) {
        // 作者不明のまま打ち切る（接続済みなら background が API で補完する）
        send({ ...gh.snapshot(), justCreated });
        return;
      }
      later(tick, 400);
    };
    tick();
  }

  function watchUrlChanges(onChange) {
    let last = location.href;
    const fire = () => {
      if (!alive()) return stop();
      if (location.href === last) return;
      last = location.href;
      lastSent = null;
      onChange();
    };
    const defer = () => later(fire, 300);

    if (globalThis.navigation) on(globalThis.navigation, 'navigate', defer);
    for (const ev of ['turbo:load', 'turbo:render', 'pjax:end', 'soft-nav:end']) {
      on(document, ev, defer);
    }
    on(window, 'popstate', defer);
    every(fire, 1500); // 上記を取りこぼした場合の保険
  }

  // compare ページからの遷移 = たった今 PR を作成した。初回ロード時のみ信用できる手掛かり。
  function cameFromComparePage() {
    try {
      const ref = new URL(document.referrer);
      return ref.hostname === 'github.com' && COMPARE_PATH_RE.test(ref.pathname);
    } catch {
      return false;
    }
  }

  if (gh) {
    if (gh.isPrPage()) reportWithRetry(cameFromComparePage());
    watchUrlChanges(() => {
      if (gh.isPrPage()) reportWithRetry(false); // ソフトナビ後の referrer は当てにならない
    });
  }
})();
