/**
 * PR ページから「ログイン中のユーザー」と「PR の作者」を読み取る。
 *
 * content script としても、background からの scripting.executeScript としても
 * 同じコードを使いたいので、ES モジュールではなくグローバルを定義する
 * 古典的なスクリプトにしてある（content script は import できないため）。
 *
 * 2026 年時点の GitHub の PR ページは React 化されていて、以前の
 * .gh-header-meta / #partial-discussion-header は存在しない。
 * また作者リンクのテキストは「表示名 (ログイン名)」なので、ログイン名は
 * テキストではなく href / data-hovercard-url から取る必要がある。
 */
(() => {
  if (globalThis.__prTabGrouper) return;

  const PR_PATH_RE = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
  const TITLE_AUTHOR_RE =
    /\bby\s+([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\s*[·•]\s*Pull Request\s*#(\d+)/g;
  const LOGIN_HREF_RE = /^\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:$|[?#])/;
  const HOVERCARD_RE = /^\/users\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\//;

  /** <a href="/yuyakinjo"> のような 1 セグメントの href だけをログイン名とみなす。 */
  const loginFromAnchor = (a) => {
    if (!a) return null;
    const hover = a.getAttribute('data-hovercard-url')?.match(HOVERCARD_RE);
    if (hover) return hover[1];
    const m = a.getAttribute('href')?.match(LOGIN_HREF_RE);
    return m ? m[1] : null;
  };

  globalThis.__prTabGrouper = {
    isPrPage: () => PR_PATH_RE.test(location.pathname),

    prNumber() {
      const m = location.pathname.match(PR_PATH_RE);
      return m ? Number(m[3]) : null;
    },

    viewer() {
      // 未ログインだと content="" になるので、空文字は「取れなかった」扱いにする
      return (
        document.querySelector('meta[name="user-login"]')?.content?.trim() ||
        document.querySelector('meta[name="octolytics-actor-login"]')?.content?.trim() ||
        null
      );
    },

    /** 作者のログイン名。確実な順に試す。 */
    author() {
      // 1) <title> の「... by <login> · Pull Request #<n> · owner/repo」
      //    セレクタに依存しないので GitHub の DOM 変更に強い
      const num = this.prNumber();
      let found = null;
      for (const m of document.title.matchAll(TITLE_AUTHOR_RE)) {
        if (num == null || Number(m[2]) === num) found = m[1];
      }
      if (found) return found;

      // 2) 作者リンクの href（テキストは「表示名 (ログイン名)」なので使わない）
      const byClass = loginFromAnchor(document.querySelector('a.author[href]'));
      if (byClass) return byClass;

      // 3) ヘッダー付近の最初のユーザーホバーカードリンク
      for (const a of document.querySelectorAll('a[data-hovercard-url^="/users/"]')) {
        const login = loginFromAnchor(a);
        if (login) return login;
      }
      return null;
    },

    title() {
      const el = document.querySelector('.js-issue-title, bdi.js-issue-title, h1 bdi');
      const text = el?.textContent?.trim();
      if (text) return text;
      return document.title.replace(/\s*\bby\s+\S+\s*[·•]\s*Pull Request.*$/, '').trim() || null;
    },

    snapshot() {
      if (!this.isPrPage()) return null;
      return {
        url: location.href,
        viewer: this.viewer(),
        author: this.author(),
        title: this.title(),
        docTitle: document.title,
      };
    },
  };
})();
