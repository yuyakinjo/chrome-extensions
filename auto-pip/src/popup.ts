import { readSettings, writeSettings } from './settings.js';
import { closeTabPip, executePipScript, inspectFramePip } from './pip-actions.js';

document.querySelector<HTMLElement>('#version')!.textContent = chrome.runtime.getManifest().version;

const enabledInput = document.querySelector<HTMLInputElement>('#enabled')!;
const siteInput = document.querySelector<HTMLInputElement>('#site-enabled')!;
const siteLabel = document.querySelector<HTMLElement>('#site')!;
const statusLabel = document.querySelector<HTMLElement>('#status')!;
const toggleButton = document.querySelector<HTMLButtonElement>('#toggle')!;
const closeButton = document.querySelector<HTMLButtonElement>('#close')!;
const diagnosticsLabel = document.querySelector<HTMLElement>('#diagnostics')!;
const diagnostics: Record<string, unknown> = { version: chrome.runtime.getManifest().version, browser: navigator.userAgent };
let settings: AutoPipSettings;
let tabId: number | undefined;
let origin: string | undefined;
let selectedFrameId: number | undefined;
let pipOwner: AutoPipFrameOwner | undefined;

function controls(busy: boolean): void {
  enabledInput.disabled = busy;
  siteInput.disabled = busy || !origin;
}

async function refresh(): Promise<void> {
  pipOwner = undefined;
  toggleButton.disabled = true;
  closeButton.disabled = true;
  if (tabId === undefined || !origin) {
    closeButton.disabled = false;
    diagnosticsLabel.textContent = JSON.stringify(diagnostics, null, 2);
    statusLabel.textContent = '「PiPを解除」は、別のタブの動画にも使えます。';
    return;
  }
  try {
    const [controllerRead, nativeRead, savedRead] = await Promise.allSettled([
      executePipScript(tabId, 'MAIN', undefined, () => window.__chromeAutoPipV1?.getStatus() ?? null),
      executePipScript(tabId, 'ISOLATED', undefined, inspectFramePip),
      chrome.storage.session.get(['autoPipLastClose', 'autoPipLastManualClose']),
    ]);
    const frames = controllerRead.status === 'fulfilled' ? controllerRead.value : [];
    const native = nativeRead.status === 'fulfilled' ? nativeRead.value : [];
    const nativePip = native.some((frame) => frame.result?.video || frame.result?.documentWindow);
    const owner = frames.find((frame) => frame.result?.inPictureInPicture) ??
      native.find((frame) => frame.result?.video || frame.result?.documentWindow);
    if (owner) pipOwner = { frameId: owner.frameId, documentId: owner.documentId };
    diagnostics.controllerFrames = frames.map(({ frameId, result }) => ({ frameId, ...result }));
    diagnostics.nativeFrames = native.map(({ frameId, result }) => ({ frameId, ...result }));
    diagnostics.readErrors = [controllerRead, nativeRead].flatMap((read) =>
      read.status === 'rejected' ? [String(read.reason)] : []);
    if (savedRead.status === 'fulfilled') {
      if (savedRead.value.autoPipLastManualClose) diagnostics.manualClose = savedRead.value.autoPipLastManualClose;
      const lastClose: unknown = savedRead.value.autoPipLastClose;
      if (lastClose && typeof lastClose === 'object' && 'tabId' in lastClose && lastClose.tabId === tabId) {
        diagnostics.automaticClose = lastClose;
      }
    }
    diagnosticsLabel.textContent = JSON.stringify(diagnostics, null, 2);
    const ready = frames.filter((frame) => frame.result !== null && frame.result !== undefined);
    const selected = ready.find((frame) => frame.result!.inPictureInPicture) ??
      ready.sort((a, b) => b.result!.candidateScore - a.result!.candidateScore)[0];
    const top = ready.find((frame) => frame.frameId === 0)?.result;
    selectedFrameId = selected?.frameId;
    const status = selected?.result;
    // 開く／閉じるを切り替えない。バックグラウンドが先に閉じても再び開かない。
    toggleButton.disabled = nativePip || !status?.supported || !status.candidateScore;
    if (!top) {
      statusLabel.textContent = '動画のタブを一度再読み込みしてください。';
    } else if (top.version !== chrome.runtime.getManifest().version) {
      statusLabel.textContent = '動画ページに古い拡張の処理が残っています。動画のタブを再読み込みしてください。';
    } else if (nativePip) {
      statusLabel.textContent = 'PiPを検出しました。「PiPを解除」で閉じられます。';
    } else if (status?.lastError) {
      statusLabel.textContent = status.lastError;
    } else if (!status?.videoCount) {
      statusLabel.textContent = 'このタブには動画がありません。「PiPを解除」は別のタブの動画にも使えます。';
    } else if (!settings.enabled || settings.disabledOrigins.includes(origin)) {
      statusLabel.textContent = 'この拡張の自動表示はOFFです。手動表示は利用できます。';
    } else if (!top.automaticSupported) {
      statusLabel.textContent = 'このChromeでは自動表示を利用できません。最新版に更新してください。';
    } else if (selectedFrameId !== 0) {
      statusLabel.textContent = '埋め込み動画です。自動表示はChromeの対象外ですが、手動表示を試せます。';
    } else if (!status.playingCount) {
      statusLabel.textContent = '自動表示はONです。動画を再生して別のタブへ移動してください。';
    } else {
      statusLabel.textContent = '再生中の動画を検出しました。別のタブに移動すると自動表示を試みます。';
    }
  } catch {
    statusLabel.textContent = 'このページにはアクセスできません。通常の動画ページで試してください。';
  } finally {
    closeButton.disabled = false;
  }
}

async function save(): Promise<void> {
  controls(true);
  const previous = settings;
  const disabled = new Set(settings.disabledOrigins);
  if (origin) {
    if (siteInput.checked) disabled.delete(origin);
    else disabled.add(origin);
  }
  settings = { enabled: enabledInput.checked, disabledOrigins: [...disabled] };
  try {
    await writeSettings(settings);
    // storage 通知を待たず、ポップアップのステータスにも新しい設定を反映する。
    if (tabId !== undefined && origin) {
      await chrome.scripting.executeScript({
        target: { tabId }, world: 'MAIN',
        func: (next: boolean) => window.__chromeAutoPipV1?.configure(next),
        args: [settings.enabled && !disabled.has(origin)],
      });
    }
    await refresh();
  } catch {
    settings = await readSettings().catch(() => previous);
    enabledInput.checked = settings.enabled;
    siteInput.checked = Boolean(origin && !settings.disabledOrigins.includes(origin));
    statusLabel.textContent = '設定の保存またはページへの反映に失敗しました。動画ページを再読み込みしてください。';
  } finally {
    controls(false);
  }
}

enabledInput.addEventListener('change', () => { void save(); });
siteInput.addEventListener('change', () => { void save(); });
toggleButton.addEventListener('click', () => {
  if (tabId === undefined || selectedFrameId === undefined) return;
  toggleButton.disabled = true;
  // クリックから直接 executeScript を呼び、Chrome のユーザー操作を引き継ぐ。
  void chrome.scripting.executeScript({
    target: { tabId, frameIds: [selectedFrameId] },
    world: 'MAIN',
    func: () => window.__chromeAutoPipV1?.open?.() ??
      { ok: false, message: '動画のタブを再読み込みして、もう一度試してください。' },
  }).then(async (results) => {
    const result = results[0]?.result;
    await refresh();
    if (result) statusLabel.textContent = result.message;
  }).catch(() => {
    statusLabel.textContent = '動画ページを再読み込みして、もう一度試してください。';
    toggleButton.disabled = false;
  });
});

closeButton.addEventListener('click', () => {
  closeButton.disabled = true;
  toggleButton.disabled = true;
  statusLabel.textContent = 'PiPを解除しています…';
  diagnostics.manualClose = { state: '解除中' };
  diagnosticsLabel.textContent = JSON.stringify(diagnostics, null, 2);
  // 所有フレームが分かっている場合は、クリックの中で直接 MAIN へ実行する。
  // runtime メッセージ、タブ探索、非同期の状態取得を先に挟まない。
  const ownerTabId = tabId;
  const closing: Promise<AutoPipGlobalCloseReport> = ownerTabId !== undefined && pipOwner
    ? closeTabPip(ownerTabId, [pipOwner]).then((report) => ({
      ok: report.ok, message: report.message, scannedTabs: 1,
      owningTabIds: [ownerTabId], reports: [{ tabId: ownerTabId, ...report }], errors: report.errors,
    }))
    : chrome.runtime.sendMessage({ type: 'auto-pip:close-all', tabId });
  void closing.then(async (report: AutoPipGlobalCloseReport) => {
    if (!report) throw new Error('バックグラウンドから応答がありません。拡張を再読み込みしてください。');
    const saved = { version: chrome.runtime.getManifest().version, ...report };
    diagnostics.manualClose = saved;
    diagnosticsLabel.textContent = JSON.stringify(diagnostics, null, 2);
    statusLabel.textContent = report.message;
    await chrome.storage.session.set({ autoPipLastManualClose: saved }).catch(() => {});
    await refresh();
    statusLabel.textContent = report.message;
  }).catch((error: unknown) => {
    diagnostics.manualClose = { error: String(error) };
    diagnosticsLabel.textContent = JSON.stringify(diagnostics, null, 2);
    statusLabel.textContent = `PiPの解除に失敗しました: ${String(error)}`;
  }).finally(() => { closeButton.disabled = false; });
});

async function init(): Promise<void> {
  try {
    const [stored, tabs] = await Promise.all([readSettings(), chrome.tabs.query({ active: true, currentWindow: true })]);
    settings = stored;
    const tab = tabs[0];
    tabId = tab?.id;
    if (tab?.url && /^https?:\/\//.test(tab.url)) origin = new URL(tab.url).origin;
    enabledInput.checked = settings.enabled;
    siteInput.checked = Boolean(origin && !settings.disabledOrigins.includes(origin));
    siteLabel.textContent = origin ? new URL(origin).host : 'このページは対象外です';
    controls(false);
    await refresh();
  } catch {
    statusLabel.textContent = '設定を読み込めませんでした。拡張を再読み込みしてください。';
  }
}

void init();
