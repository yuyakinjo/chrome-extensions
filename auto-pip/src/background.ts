import { closeAllTabsPip, closeTabPip } from './pip-actions.js';

// ページの visibilitychange が届かなくても、Chrome のタブ選択で PiP を解除する。
async function closeActivatedTab(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || !tab.url || !/^https?:\/\//.test(tab.url)) return;
    // 通知の失敗で直接解除を止めない。
    void chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      injectImmediately: true,
      // ページ内で進行中の PiP リクエストにも、タブに戻ったことを知らせる。
      func: () => { void window.__chromeAutoPipV1?.onTabActivated?.(false).catch(() => {}); },
    }).catch(() => {});
    const report = await closeTabPip(tabId);
    if (report.observed || report.remaining || report.errors.length) {
      await chrome.storage.session.set({ autoPipLastClose: { tabId, version: chrome.runtime.getManifest().version, ...report } });
    }
  } catch (error) {
    await chrome.storage.session.set({ autoPipLastClose: { tabId, error: String(error) } }).catch(() => {});
  }
}

// イベントリスナーは service worker 起動時に同期的に登録する。
chrome.tabs.onActivated.addListener(({ tabId }) => { void closeActivatedTab(tabId); });
// ウィンドウのフォーカス通知はツールバーや PiP 自身の操作でも発生するため使わない。

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'auto-pip:close-all') return;
  // 拡張自身のポップアップからの明示的な手動操作だけを受け付ける。
  if (sender.id !== chrome.runtime.id || sender.tab) return;
  const preferredTabId = 'tabId' in message && typeof message.tabId === 'number' ? message.tabId : undefined;
  void closeAllTabsPip(preferredTabId).then(async (report) => {
    const saved = { version: chrome.runtime.getManifest().version, ...report };
    await chrome.storage.session.set({ autoPipLastManualClose: saved }).catch(() => {});
    sendResponse(saved);
  }).catch((error: unknown) => {
    sendResponse({ ok: false, message: `PiPの解除に失敗しました: ${String(error)}`, errors: [String(error)] });
  });
  return true;
});
