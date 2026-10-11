// executeScript に渡す関数は、外側の変数や import に依存しないようにする。
export function inspectFramePip(): AutoPipFrameState {
  const errors: string[] = [];
  let video = false;
  let documentWindow = false;
  try { video = Boolean(document.pictureInPictureElement); } catch (error) { errors.push(String(error)); }
  try {
    const pipWindow = window.documentPictureInPicture?.window;
    documentWindow = Boolean(pipWindow && !pipWindow.closed);
  } catch (error) { errors.push(String(error)); }
  return { video, documentWindow, errors };
}

export function closeFramePip(): AutoPipFrameClose {
  // この関数は MAIN world 専用。手動クリックとタブ復帰で同じ解除処理を使う。
  if (window.__chromeAutoPipV1) {
    let before = Boolean(document.pictureInPictureElement);
    try {
      const pipWindow = window.documentPictureInPicture?.window;
      before ||= Boolean(pipWindow && !pipWindow.closed);
    } catch { /* Document PiP の読み取り失敗で動画 PiP の解除を止めない。 */ }
    void window.__chromeAutoPipV1.close().catch(() => {});
    return { observed: before, remaining: before, errors: [] };
  }
  // Document PiP が使えなくても、通常の動画 PiP の解除は独立して試す。
  let observed = false;
  const errors: string[] = [];
  try {
    if (document.pictureInPictureElement) {
      observed = true;
      // API の Promise を待たず、拡張側で実際のウィンドウの状態を確認する。
      void Promise.resolve(document.exitPictureInPicture()).catch(() => {});
    }
  } catch (error) { errors.push(String(error)); }
  try {
    const pipWindow = window.documentPictureInPicture?.window;
    if (pipWindow && !pipWindow.closed) {
      observed = true;
      pipWindow.close();
    }
  } catch (error) { errors.push(String(error)); }
  let remaining = false;
  try { remaining = Boolean(document.pictureInPictureElement); } catch (error) { errors.push(String(error)); }
  try {
    const pipWindow = window.documentPictureInPicture?.window;
    remaining ||= Boolean(pipWindow && !pipWindow.closed);
  } catch (error) { errors.push(String(error)); }
  return { observed, remaining, errors: [...new Set(errors)] };
}

const worlds = ['ISOLATED', 'MAIN'] as const;

// 読み込み中・破棄されたタブを待ち続けない。解除用の関数はメインフレーム／所有フレームだけに送る。
export async function executePipScript<T>(
  tabId: number, world: typeof worlds[number], frameId: number | undefined,
  func: () => T,
): Promise<chrome.scripting.InjectionResult<chrome.scripting.Awaited<T>>[]> {
  for (let attempt = 0; ; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        chrome.scripting.executeScript<[], T>({
          target: frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] },
          world, func, injectImmediately: true,
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('PiP操作が応答しませんでした。')), 1500);
        }),
      ]);
    } catch (error) {
      // タブ切り替え直後に prerender / BFCache のページが入れ替わった場合は再取得する。
      if (attempt || frameId === undefined || !/Frame with ID .* was removed|No frame with id/i.test(String(error))) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function findPipOwners(tabId: number, allFrames: boolean): Promise<{ owners: AutoPipFrameOwner[]; errors: string[] }> {
  const reads = await Promise.allSettled(worlds.map((world) =>
    executePipScript(tabId, world, allFrames ? undefined : 0, inspectFramePip)));
  const owners = new Map<number, AutoPipFrameOwner>();
  const errors: string[] = [];
  for (const read of reads) {
    if (read.status === 'rejected') errors.push(String(read.reason));
    else for (const frame of read.value) {
      if (!allFrames && frame.frameId !== 0) continue;
      if (!frame.result) continue;
      errors.push(...frame.result.errors);
      if (frame.result.video || frame.result.documentWindow) {
        owners.set(frame.frameId, { frameId: frame.frameId, documentId: frame.documentId });
      }
    }
  }
  return { owners: [...owners.values()], errors: [...new Set(errors)] };
}

const frameJobs = new Map<string, Promise<AutoPipFrameCloseReport>>();

function closeOwnerFrame(tabId: number, owner: AutoPipFrameOwner, knownOwner: boolean): Promise<AutoPipFrameCloseReport> {
  const key = `${tabId}:${owner.frameId}`;
  const current = frameJobs.get(key);
  if (current) return current;
  const job = closeOwnerFrameOnce(tabId, owner, knownOwner).finally(() => { frameJobs.delete(key); });
  frameJobs.set(key, job);
  return job;
}

async function closeOwnerFrameOnce(tabId: number, owner: AutoPipFrameOwner, knownOwner: boolean): Promise<AutoPipFrameCloseReport> {
  const errors: string[] = [];
  const documentIds = new Set<string>(owner.documentId ? [owner.documentId] : []);
  let observed = false;
  let remaining = false;
  let verified = false;
  // ISOLATED は読み取り専用。解除を別の実行環境へ渡さない。
  try {
    const attempts = await executePipScript(tabId, 'MAIN', owner.frameId, closeFramePip);
    for (const frame of attempts) {
      if (frame.frameId !== owner.frameId || !frame.result) continue;
      observed ||= frame.result.observed;
      if (frame.result.observed && frame.documentId) documentIds.add(frame.documentId);
      errors.push(...frame.result.errors);
    }
  } catch (error) { errors.push(String(error)); }
  // 待機は拡張側で行う。動画ページの Promise やタイマーには依存しない。
  for (let attempt = 0; attempt < 12; attempt++) {
    const checks = await Promise.allSettled(worlds.map((checkWorld) =>
      executePipScript(tabId, checkWorld, owner.frameId, inspectFramePip)));
    const checkedDocuments = new Set<string>();
    remaining = false;
    verified = false;
    for (const check of checks) {
      if (check.status === 'rejected') errors.push(String(check.reason));
      else for (const frame of check.value) {
        // 別の iframe の「PiP なし」で、所有フレームの解除成功を判定しない。
        if (frame.frameId !== owner.frameId || !frame.result) continue;
        remaining ||= frame.result.video || frame.result.documentWindow;
        errors.push(...frame.result.errors);
        if (!frame.result.errors.length) {
          if (frame.documentId) checkedDocuments.add(frame.documentId);
          if (!documentIds.size) verified = true;
        }
      }
    }
    if (documentIds.size) verified = [...documentIds].every((id) => checkedDocuments.has(id));
    if (!remaining || !verified) break;
    if (attempt < 11) await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  if (remaining) errors.push('MAIN world で解除を呼びましたが、PiPがまだ開いています。');
  if (!verified) errors.push(`frame ${owner.frameId}: 動画があるページで解除結果を確認できませんでした。`);
  return {
    frameId: owner.frameId, observed, remaining, verified,
    ok: (observed || knownOwner) && verified && !remaining,
    documentIds: [...documentIds], world: 'MAIN', errors: [...new Set(errors)],
  };
}

export async function closeTabPip(tabId: number, owners?: AutoPipFrameOwner[]): Promise<AutoPipCloseReport> {
  let frames: AutoPipFrameCloseReport[];
  const discoveryErrors: string[] = [];
  if (owners?.length) {
    frames = await Promise.all(owners.map((owner) => closeOwnerFrame(tabId, owner, true)));
  } else {
    // YouTube のようなトップフレームの動画を最初に解除する。広告 iframe に依存しない。
    const top = await closeOwnerFrame(tabId, { frameId: 0 }, false);
    frames = [top];
    if (!top.observed && !top.remaining) {
      const found = await findPipOwners(tabId, true);
      discoveryErrors.push(...found.errors);
      if (found.owners.length) frames = await Promise.all(found.owners.map((owner) => closeOwnerFrame(tabId, owner, true)));
    }
  }
  const observed = frames.some((frame) => frame.observed);
  const remaining = frames.some((frame) => frame.remaining);
  const checkedFrames = frames.filter((frame) => frame.verified).length;
  const ok = frames.length > 0 && frames.every((frame) => frame.ok);
  const errors = [...new Set([...discoveryErrors, ...frames.flatMap((frame) => frame.errors)])];
  return {
    ok, observed, remaining, checkedFrames, frames, errors,
    message: ok ? 'ピクチャインピクチャの解除を確認しました。'
      : remaining ? 'PiPがまだ開いています。下の診断結果を確認してください。'
      : !checkedFrames || errors.length ? '解除結果を確認できませんでした。下の診断結果を確認してください。'
      : 'このページではPiPを検出できませんでした。まだ表示されている場合は、診断結果を確認してください。',
  };
}

export async function closeAllTabsPip(preferredTabId?: number): Promise<AutoPipGlobalCloseReport> {
  const tabs = (await chrome.tabs.query({})).filter((tab) =>
    tab.id !== undefined && tab.url && /^https?:\/\//.test(tab.url));
  const errors: string[] = [];
  const reports: Array<AutoPipCloseReport & { tabId: number }> = [];
  let scannedTabs = 0;
  const result = (): AutoPipGlobalCloseReport => {
    reports.sort((a, b) => a.tabId - b.tabId);
    const ok = reports.length > 0 && reports.every((report) => report.ok);
    return {
      ok, scannedTabs, owningTabIds: reports.map((report) => report.tabId), reports, errors,
      message: !reports.length ? '開いているタブでPiPを検出できませんでした。まだ表示されている場合は診断結果を確認してください。'
        : ok ? '動画タブのピクチャインピクチャの解除を確認しました。'
        : 'PiPの解除を確認できませんでした。診断結果を確認してください。',
    };
  };
  // 明示的なクリックは今のタブを先に処理する。他の休止中のタブを待たせない。
  if (preferredTabId !== undefined && tabs.some((tab) => tab.id === preferredTabId)) {
    scannedTabs++;
    const report = await closeTabPip(preferredTabId);
    if (report.observed || report.remaining) {
      reports.push({ tabId: preferredTabId, ...report });
      return result();
    }
    errors.push(...report.errors.map((error) => `tab ${preferredTabId}: ${error}`));
  }
  const rest = tabs.filter((tab) => tab.id !== preferredTabId);
  const scan = async (allFrames: boolean): Promise<void> => {
    await Promise.all(rest.map(async (tab) => {
      const found = await findPipOwners(tab.id!, allFrames);
      errors.push(...found.errors.map((error) => `tab ${tab.id}: ${error}`));
      // 見つかった時点で解除する。他のタブの探索完了を待たない。
      if (found.owners.length) reports.push({ tabId: tab.id!, ...await closeTabPip(tab.id!, found.owners) });
    }));
  };
  scannedTabs += rest.length;
  await scan(false);
  if (!reports.length) await scan(true);
  return result();
}
