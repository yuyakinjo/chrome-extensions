// MAIN world: MediaSession はサイトと同じ JavaScript の世界で設定する。
// content script は通常のスクリプトなので import / export を置かない。
(() => {
  if (window.__chromeAutoPipV1) return;

  const CONFIG_EVENT = 'chrome-auto-pip:configure-v1';
  const READY_EVENT = 'chrome-auto-pip:ready-v1';
  const isTopFrame = window === window.top;
  let enabled = false;
  let automaticSupported = false;
  let lastError = '';
  let pending = false;
  let returnCount = 0;
  let closing: Promise<void> | null = null;
  let automaticVideo: HTMLVideoElement | null = null;
  let documentVideo: { video: HTMLVideoElement; window: Window; restore(): void } | null = null;
  let siteHandler: MediaSessionActionHandler | null = null;

  // TypeScript の DOM 型には Chrome のこのアクションがまだ含まれていない。
  type Action = MediaSessionAction | 'enterpictureinpicture';
  type SetHandler = (action: Action, handler: MediaSessionActionHandler | null) => void;
  const session = navigator.mediaSession;
  const originalSetHandler = session?.setActionHandler.bind(session) as SetHandler | undefined;

  function videos(): HTMLVideoElement[] {
    const found: HTMLVideoElement[] = [];
    function visit(root: Document | ShadowRoot): void {
      found.push(...root.querySelectorAll<HTMLVideoElement>('video'));
      // open Shadow DOM のプレイヤーにも対応する。
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    }
    visit(document);
    if (documentVideo && !found.includes(documentVideo.video)) found.push(documentVideo.video);
    return found;
  }

  function playing(video: HTMLVideoElement): boolean {
    return !video.paused && !video.ended;
  }

  function score(video: HTMLVideoElement): number {
    const rect = video.getBoundingClientRect();
    // 再生中を優先し、複数なら表示面積の大きな動画を選ぶ。
    return (playing(video) ? 1e12 : 0) + Math.min(rect.width * rect.height, 1e10);
  }

  function candidate(automatic: boolean): HTMLVideoElement | undefined {
    return videos()
      .filter((video) => video.readyState >= 1 && video.videoWidth > 0 &&
        !video.disablePictureInPicture && (!automatic || playing(video)))
      .sort((a, b) => score(b) - score(a))[0];
  }

  function explain(error: unknown): string {
    const name = error instanceof Error ? error.name : '';
    if (name === 'NotAllowedError') {
      return 'Chrome の自動PiPの許可を確認してください。手動表示はボタンを押して試せます。';
    }
    if (name === 'SecurityError' || name === 'NotSupportedError') {
      return 'このサイトまたは動画では、ピクチャインピクチャが許可されていません。';
    }
    if (name === 'InvalidStateError') return '動画を再生してから、もう一度試してください。';
    return 'ピクチャインピクチャを開けませんでした。動画ページを再読み込みして試してください。';
  }

  function documentPipApi(): Window['documentPictureInPicture'] | null {
    try { return window.documentPictureInPicture ?? null; } catch { return null; }
  }

  function documentPipWindow(): Window | null {
    try { return documentPipApi()?.window ?? null; } catch { return null; }
  }

  function inPictureInPicture(): boolean {
    if (document.pictureInPictureElement) return true;
    const pipWindow = documentPipWindow();
    return Boolean(document.pictureInPictureElement || (pipWindow && !pipWindow.closed));
  }

  async function openDocumentPictureInPicture(video: HTMLVideoElement): Promise<void> {
    const api = documentPipApi()!;
    // MediaSession のアクション内で、ユーザー操作の許可が有効なうちに呼ぶ。
    const width = 480;
    const height = Math.max(180, Math.round(width * (video.videoHeight || 9) / (video.videoWidth || 16)));
    const pipWindow = await api.requestWindow!({ width, height });
    if (pipWindow.closed) return;
    const currentParent = video.parentNode;
    if (!currentParent || !video.isConnected) {
      pipWindow.close();
      throw new Error('動画の表示位置が変わりました。');
    }
    const parent = currentParent;
    const placeholder = document.createComment('Auto PiP video position');
    const nextSibling = video.nextSibling;
    const originalStyle = video.getAttribute('style');
    const originalControls = video.controls;
    const wasPlaying = playing(video);
    let restored = false;
    function restore(): void {
      if (restored) return;
      restored = true;
      const resume = playing(video);
      if (placeholder.parentNode) placeholder.replaceWith(video);
      else if (parent.isConnected) parent.insertBefore(video, nextSibling?.parentNode === parent ? nextSibling : null);
      // サイトが遷移して元のプレイヤーを取り除いた場合は、古い動画を再生しない。
      if (originalStyle === null) video.removeAttribute('style');
      else video.setAttribute('style', originalStyle);
      video.controls = originalControls;
      if (documentVideo?.window === pipWindow) documentVideo = null;
      if (resume && video.isConnected && video.ownerDocument === document) {
        void video.play().catch((error: unknown) => { lastError = `動画の再開に失敗しました: ${String(error)}`; });
      }
    }
    documentVideo = { video, window: pipWindow, restore };
    // 拡張の解除、Chrome の自動解除、ウィンドウの × のいずれでも元に戻す。
    pipWindow.addEventListener('pagehide', restore, { once: true });
    try {
      const style = pipWindow.document.createElement('style');
      style.textContent = 'html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}';
      pipWindow.document.head.append(style);
      parent.insertBefore(placeholder, video);
      video.style.cssText = 'display:block;position:static;width:100%;height:100%;object-fit:contain;background:#000';
      video.controls = true;
      pipWindow.document.body.append(video);
      if (wasPlaying) await video.play();
    } catch (error) {
      restore();
      pipWindow.close();
      if (wasPlaying && video.isConnected && video.ownerDocument === document) void video.play().catch(() => {});
      throw error;
    }
  }

  function closePictureInPicture(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      let apiError = '';
      if (inPictureInPicture()) {
        // 開いたページと同じ MAIN world で、呼び出し元から直接解除する。
        if (document.pictureInPictureElement) {
          void Promise.resolve(document.exitPictureInPicture()).catch((error: unknown) => { apiError = String(error); });
        }
        const pipWindow = documentPipWindow();
        if (pipWindow && !pipWindow.closed) pipWindow.close();
      }
      for (let attempt = 0; inPictureInPicture() && attempt < 20; attempt++) {
        if (apiError) throw new Error(apiError);
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
      }
      if (inPictureInPicture()) throw new Error('PiP window is still open');
      automaticVideo = null;
    })().finally(() => { closing = null; });
    return closing;
  }

  async function closeOnReturn(): Promise<void> {
    try {
      await closePictureInPicture();
      lastError = '';
    } catch (error) {
      lastError = `PiPの解除に失敗しました: ${String(error)}`;
    }
  }

  async function closeAutomatic(): Promise<void> {
    if (documentVideo) {
      await closeOnReturn();
      return;
    }
    if (!automaticVideo || document.pictureInPictureElement !== automaticVideo) return;
    await closeOnReturn();
  }

  async function enter(automatic: boolean): Promise<AutoPipResult> {
    if (pending) return { ok: false, message: '表示を切り替えています。' };
    if (!document.pictureInPictureEnabled) {
      return { ok: false, message: 'このページではピクチャインピクチャを利用できません。' };
    }
    if (automatic && (!enabled || !document.hidden)) {
      return { ok: false, message: '自動表示の対象ではありません。' };
    }
    // サイトやユーザーが開いた PiP は、自動処理で置き換えない。
    if (inPictureInPicture()) return { ok: true, message: 'すでに表示しています。' };
    const video = candidate(automatic);
    if (!video) return { ok: false, message: '表示できる動画がありません。動画を再生してください。' };

    pending = true;
    const requestReturnCount = returnCount;
    try {
      const useDocumentPip = automatic && Boolean(documentPipApi()?.requestWindow);
      if (useDocumentPip) await openDocumentPictureInPicture(video);
      else await video.requestPictureInPicture();
      lastError = '';
      if (automatic) {
        if (!useDocumentPip) {
          automaticVideo = video;
          video.addEventListener('leavepictureinpicture', () => {
            if (automaticVideo === video) automaticVideo = null;
          }, { once: true });
        }
        // 開いている途中に元のタブへ戻った／設定を OFF にした場合も閉じる。
        if (!document.hidden || !enabled) await closeAutomatic();
      }
      // 手動表示でも、処理中にタブを離れて戻った場合は閉じる。
      if (returnCount !== requestReturnCount) await closeOnReturn();
      return { ok: true, message: 'ピクチャインピクチャで表示しました。' };
    } catch (error) {
      lastError = explain(error);
      return { ok: false, message: lastError };
    } finally {
      pending = false;
    }
  }

  const handler: MediaSessionActionHandler = (details) => {
    const reason = (details as MediaSessionActionDetails & { reason?: string }).reason;
    const automatic = reason === 'contentoccluded' || document.hidden;
    // 自動表示の動画は、自分で閉じられる Document PiP ウィンドウで開く。
    if (automatic && documentPipApi()?.requestWindow && candidate(true)) {
      void enter(true);
      return;
    }
    // サイトが独自の PiP を用意している場合は、そのハンドラに任せる。
    if (siteHandler) {
      const requestReturnCount = returnCount;
      const result: unknown = siteHandler(details);
      // サイトの非同期処理が、タブに戻ったあとでウィンドウを開いても閉じる。
      void Promise.resolve(result).then(() => {
        if (returnCount !== requestReturnCount) return closeOnReturn();
      }).catch((error: unknown) => { lastError = explain(error); });
      return;
    }
    void enter(automatic);
  };

  function updateHandler(): void {
    if (!isTopFrame || !originalSetHandler) return;
    try {
      originalSetHandler('enterpictureinpicture', enabled ? handler : siteHandler);
      automaticSupported = true;
    } catch {
      automaticSupported = false;
    }
  }

  if (isTopFrame && originalSetHandler) {
    // document_start でサイトの登録を追跡し、後から設定されても失わない。
    session.setActionHandler = function (action: Action, next: MediaSessionActionHandler | null): void {
      if (action !== 'enterpictureinpicture') {
        originalSetHandler(action, next);
        return;
      }
      // 先にネイティブ API で引数を検証する。例外時は保存済みハンドラを変えない。
      originalSetHandler(action, next);
      siteHandler = next;
      updateHandler();
    };
  }

  window.__chromeAutoPipV1 = {
    async onTabActivated(closeNow = true): Promise<void> {
      // Chrome の通知はページの可視性や YouTube のイベント処理に依存しない。
      returnCount++;
      if (closeNow) await closeOnReturn();
    },
    configure(next): void {
      enabled = isTopFrame && next;
      updateHandler();
      if (!enabled) void closeAutomatic();
    },
    getStatus(): AutoPipStatus {
      const all = videos();
      const selected = candidate(false);
      return {
        version: '0.1.8',
        supported: Boolean(document.pictureInPictureEnabled),
        automaticSupported,
        automaticMode: documentPipApi()?.requestWindow ? 'document' : 'video',
        enabled,
        videoCount: all.length,
        playingCount: all.filter(playing).length,
        candidateScore: selected ? score(selected) + 1 : 0,
        inPictureInPicture: inPictureInPicture(),
        lastError,
      };
    },
    open(): Promise<AutoPipResult> {
      return enter(false);
    },
    async close(): Promise<AutoPipResult> {
      try {
        await closePictureInPicture();
        lastError = '';
        return { ok: true, message: 'ピクチャインピクチャの解除を確認しました。' };
      } catch (error) {
        lastError = `PiPの解除に失敗しました: ${String(error)}`;
        return { ok: false, message: lastError };
      }
    },
    async toggle(): Promise<AutoPipResult> {
      if (inPictureInPicture()) return window.__chromeAutoPipV1!.close();
      return enter(false);
    },
  };

  if (isTopFrame) {
    window.addEventListener(CONFIG_EVENT, (event) => {
      // この境界を通すのは ON/OFF のみ。ページから特権 API は呼べない。
      const detail: unknown = (event as CustomEvent).detail;
      if (typeof detail === 'boolean') window.__chromeAutoPipV1?.configure(detail);
    });
    window.dispatchEvent(new Event(READY_EVENT));
  }

  // iframe 内の動画、手動表示、サイト側で開いた PiP にも適用する。
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      returnCount++;
      void closeOnReturn();
    }
  });
})();
