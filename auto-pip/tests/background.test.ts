import { expect, test } from 'bun:test';
import { createContext, runInContext } from 'node:vm';

const source = await Bun.file(new URL('../src/background.ts', import.meta.url)).text();
const script = new Bun.Transpiler({ loader: 'ts' }).transformSync(source).replace(/^import .*;$/gm, '');
const actionsSource = await Bun.file(new URL('../src/pip-actions.ts', import.meta.url)).text();
const actions = new Bun.Transpiler({ loader: 'ts' }).transformSync(actionsSource).replace(/^export /gm, '');
const controllerSource = await Bun.file(new URL('../src/controller.ts', import.meta.url)).text();
const controllerScript = new Bun.Transpiler({ loader: 'ts' }).transformSync(controllerSource);
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function frame({ documentPip = false, legacy = false, modifiedMainApi = false, initialPip = true, noOpExit = false,
  hangingExit = false, isolatedHangingExit = false, delayedExit = 0 } = {}) {
  let pip: object | null = documentPip || !initialPip ? null : {};
  let exits = 0;
  let notifications = 0;
  let isolatedExits = 0;
  const pipWindow = { closed: false, close() { this.closed = true; } };
  const nativeDocument = {
    // 表示イベントを送らず、hidden も変更しない状態でテストする。
    hidden: true,
    get pictureInPictureElement() { return pip; },
    exitPictureInPicture(): Promise<void> {
      isolatedExits++;
      return new Promise<never>(() => {});
    },
  };
  async function exitMainPip() {
    exits++;
    if (!noOpExit) {
      if (delayedExit) setTimeout(() => { pip = null; }, delayedExit);
      else pip = null;
    }
    if (hangingExit) return new Promise<never>(() => {});
  }
  if (!isolatedHangingExit) nativeDocument.exitPictureInPicture = exitMainPip;
  const events = new EventTarget();
  const nativeWindow = {
    documentPictureInPicture: { window: documentPip ? pipWindow : null },
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  const mainDocument = {
    ...nativeDocument,
    get pictureInPictureElement() { return pip; },
    pictureInPictureEnabled: true,
    querySelectorAll() { return []; },
    addEventListener: events.addEventListener.bind(events),
    exitPictureInPicture: modifiedMainApi
      ? () => { throw new Error('Site replaced the API'); }
      : exitMainPip,
  };
  const mainWindow = {
    ...nativeWindow,
    top: null as unknown,
    __chromeAutoPipV1: undefined as any,
  };
  mainWindow.top = mainWindow;
  const contexts = {
    ISOLATED: createContext({ window: nativeWindow, document: nativeDocument, setTimeout, Event }),
    MAIN: createContext({ window: mainWindow, document: mainDocument, navigator: {}, setTimeout, Event }),
  };
  if (!legacy) {
    runInContext(controllerScript, contexts.MAIN);
    const activated = mainWindow.__chromeAutoPipV1.onTabActivated;
    mainWindow.__chromeAutoPipV1.onTabActivated = (...args: unknown[]) => {
      notifications++;
      return activated(...args);
    };
  }
  return {
    contexts,
    get inPip() { return Boolean(pip || (documentPip && !pipWindow.closed)); },
    get exits() { return exits; },
    get isolatedExits() { return isolatedExits; },
    get notifications() { return notifications; },
  };
}

function setup(frames = [frame()], otherTabs: Array<{ id: number; url: string; frames: ReturnType<typeof frame>[] }> = []) {
  let onActivated!: (info: { tabId: number }) => void;
  let onFocusChanged: ((windowId: number) => void) | undefined;
  let onMessage!: (message: object, sender: object, respond: (value: unknown) => void) => boolean | undefined;
  const tab = { id: 7, windowId: 3, active: true, url: 'https://www.youtube.com/watch?v=test' };
  const browserWindow = { focused: true };
  let rejectInjection = false;
  let rejectAllFrames = false;
  let rejectTopClose = false;
  let omitTop = false;
  let topFailures = 0;
  let replaceDocumentOnCheck = false;
  const stalledTabs = new Set<number>();
  const injections: Array<{ tabId: number; allFrames?: boolean; frameIds?: number[]; world: string; injectImmediately?: boolean }> = [];
  const queries: object[] = [];
  const stored: Record<string, unknown> = {};
  const chrome = {
    tabs: {
      onActivated: { addListener(listener: typeof onActivated) { onActivated = listener; } },
      async get() { return tab; },
      async query(options: object) { queries.push(options); return [tab, ...otherTabs.map(({ id, url }) => ({ id, url }))]; },
    },
    storage: { session: { async set(values: object) { Object.assign(stored, values); } } },
    runtime: {
      id: 'test-extension',
      getManifest() { return { version: '0.1.8' }; },
      onMessage: { addListener(listener: typeof onMessage) { onMessage = listener; } },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      onFocusChanged: { addListener(listener: typeof onFocusChanged) { onFocusChanged = listener; } },
      async get() { return browserWindow; },
    },
    scripting: {
      async executeScript(options: {
        target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
        world: 'ISOLATED' | 'MAIN';
        func: Function;
        injectImmediately?: boolean;
      }) {
        if (rejectInjection) throw new Error('Site access is withheld');
        injections.push({ ...options.target, world: options.world, injectImmediately: options.injectImmediately });
        if (stalledTabs.has(options.target.tabId)) return new Promise<never>(() => {});
        if (options.target.allFrames && rejectAllFrames) throw new Error('Frame with ID 109 was removed.');
        if (options.target.frameIds?.includes(0) && options.func.name === 'closeFramePip') {
          if (rejectTopClose || topFailures-- > 0) throw new Error('Frame with ID 0 was removed.');
        }
        // Chrome と同様に関数をシリアライズし、外側のスコープを持たずに実行する。
        const tabFrames = options.target.tabId === tab.id ? frames
          : otherTabs.find((other) => other.id === options.target.tabId)?.frames ?? [];
        return Promise.all(tabFrames.map((item, frameId) => ({ item, frameId })).filter(({ frameId }) =>
          !(omitTop && frameId === 0) && (options.target.allFrames || (options.target.frameIds ?? [0]).includes(frameId))
        ).map(async ({ item, frameId }) => ({
          frameId,
          documentId: replaceDocumentOnCheck && options.func.name === 'inspectFramePip'
            ? 'replacement-document' : `document-${options.target.tabId}-${frameId}`,
          result: await runInContext(`(${options.func.toString()})()`, item.contexts[options.world]),
        })));
      },
    },
  };
  const context = createContext({ chrome, setTimeout, clearTimeout });
  runInContext(actions, context);
  runInContext(script, context);
  return {
    tab, browserWindow, frames, injections, queries, stored,
    activate() { onActivated({ tabId: tab.id }); },
    focus(windowId = 3) { onFocusChanged?.(windowId); },
    closeFromPopup(preferredTabId: number | undefined = tab.id) {
      return new Promise<any>((resolve) => {
        onMessage({ type: 'auto-pip:close-all', tabId: preferredTabId }, { id: 'test-extension' }, resolve);
      });
    },
    closeTab() { return runInContext('closeTabPip(7)', context) as Promise<AutoPipCloseReport>; },
    reject() { rejectInjection = true; },
    failAllFrames() { rejectAllFrames = true; },
    loseTop() { rejectTopClose = true; omitTop = true; },
    failTopOnce() { topFailures = 1; },
    replaceDocument() { replaceDocumentOnCheck = true; },
    stallTab(id: number) { stalledTabs.add(id); },
  };
}

test('Chrome tab activation closes PiP without visibilitychange or a visible document', async () => {
  const env = setup();
  env.activate();
  await flush();
  expect(env.frames[0]!.inPip).toBe(false);
  expect(env.frames[0]!.exits).toBe(1);
  expect(env.frames[0]!.notifications).toBe(1);
  expect(env.injections).toEqual([
    { tabId: 7, frameIds: [0], world: 'MAIN', injectImmediately: true },
    { tabId: 7, frameIds: [0], world: 'MAIN', injectImmediately: true },
    { tabId: 7, frameIds: [0], world: 'ISOLATED', injectImmediately: true },
    { tabId: 7, frameIds: [0], world: 'MAIN', injectImmediately: true },
  ]);
});

test('closing works in MAIN even when the isolated API never settles or closes the window', async () => {
  const env = setup([frame({ isolatedHangingExit: true })]);
  env.activate();
  await flush();
  expect(env.frames[0]!.inPip).toBe(false);
  expect(env.frames[0]!.exits).toBe(1);
  expect(env.frames[0]!.isolatedExits).toBe(0);
});

test('a page without a controller still closes through its MAIN API', async () => {
  const env = setup([frame({ legacy: true, isolatedHangingExit: true })]);
  const report = await env.closeFromPopup();
  expect(report.ok).toBe(true);
  expect(env.frames[0]!.exits).toBe(1);
  expect(env.frames[0]!.isolatedExits).toBe(0);
});

test('a broken MAIN API is reported without switching the close to ISOLATED', async () => {
  const env = setup([frame({ modifiedMainApi: true, isolatedHangingExit: true })]);
  const report = await env.closeFromPopup();
  expect(report.ok).toBe(false);
  expect(env.frames[0]!.inPip).toBe(true);
  expect(env.frames[0]!.isolatedExits).toBe(0);
});

test('an embedded Document PiP is discovered and closed in its own frame', async () => {
  const env = setup([frame({ initialPip: false }), frame({ documentPip: true })]);
  env.activate();
  await flush();
  expect(env.frames.map((item) => item.inPip)).toEqual([false, false]);
  expect(env.frames[1]!.exits).toBe(0);
});

test('focus events from the toolbar or PiP do not trigger an unwanted close', async () => {
  const env = setup();
  env.focus();
  await flush();
  expect(env.queries).toEqual([]);
  expect(env.frames[0]!.inPip).toBe(true);
});

test('stale activation is ignored, but a focus-state race does not skip a real tab return', async () => {
  const env = setup();
  env.tab.active = false;
  env.activate();
  await flush();
  expect(env.frames[0]!.inPip).toBe(true);
  env.tab.active = true;
  env.browserWindow.focused = false;
  env.activate();
  await flush();
  expect(env.frames[0]!.inPip).toBe(false);
});

test('losing Chrome focus does not close PiP', async () => {
  const env = setup();
  env.focus(-1);
  await flush();
  expect(env.queries).toEqual([]);
  expect(env.frames[0]!.inPip).toBe(true);
});

test('inaccessible pages and withheld permissions are handled without unhandled rejections', async () => {
  const env = setup();
  env.tab.url = 'chrome://newtab/';
  env.activate();
  await flush();
  expect(env.injections).toEqual([]);
  env.tab.url = 'https://www.youtube.com/watch?v=test';
  env.reject();
  env.activate();
  await flush();
  expect(env.frames[0]!.inPip).toBe(true);
  expect(JSON.stringify(env.stored)).toContain('Site access is withheld');
});

test('manual close scans the video tabs instead of requiring the popup tab to have a video', async () => {
  const env = setup();
  const report = await env.closeFromPopup();
  expect(env.queries).toEqual([{}]);
  expect(report.owningTabIds).toEqual([7]);
  expect(report.ok).toBe(true);
  expect(env.frames[0]!.inPip).toBe(false);
});

test('a popup on GitHub closes the YouTube owner without changing the GitHub page', async () => {
  const github = frame({ initialPip: false });
  const youtube = frame();
  const env = setup([github], [{ id: 8, url: 'https://www.youtube.com/watch?v=test', frames: [youtube] }]);
  env.tab.url = 'https://github.com/';
  const report = await env.closeFromPopup();
  expect(report.scannedTabs).toBe(2);
  expect(report.owningTabIds).toEqual([8]);
  expect(report.ok).toBe(true);
  expect(youtube.inPip).toBe(false);
  expect(github.exits).toBe(0);
});

test('manual close reports failure when the native API leaves the PiP open', async () => {
  const env = setup([frame({ noOpExit: true })]);
  const report = await env.closeFromPopup();
  expect(report.ok).toBe(false);
  expect(report.reports[0].observed).toBe(true);
  expect(report.reports[0].remaining).toBe(true);
  expect(report.message).toContain('確認できません');
  expect(env.frames[0]!.inPip).toBe(true);
});

test('removing an advertising iframe cannot stop a top-frame PiP close', async () => {
  const env = setup([frame(), frame({ initialPip: false })]);
  env.failAllFrames();
  const report = await env.closeFromPopup();
  expect(report.ok).toBe(true);
  expect(env.frames[0]!.inPip).toBe(false);
  expect(env.injections.every((injection) => !injection.allFrames)).toBe(true);
});

test('a missing owner frame cannot be verified by an unrelated frame without PiP', async () => {
  const env = setup([frame(), frame({ initialPip: false })]);
  env.loseTop();
  const report = await env.closeTab();
  expect(report.ok).toBe(false);
  expect(report.checkedFrames).toBe(0);
  expect(report.frames[0]!.verified).toBe(false);
  expect(report.errors.some((error) => error.includes('Frame with ID 0 was removed'))).toBe(true);
  expect(env.frames[0]!.inPip).toBe(true);
});

test('a transient top-frame replacement is retried before reporting a close failure', async () => {
  const env = setup();
  env.failTopOnce();
  const report = await env.closeFromPopup();
  expect(report.ok).toBe(true);
  expect(report.reports[0].checkedFrames).toBe(1);
  expect(env.frames[0]!.inPip).toBe(false);
});

test('verification on a replacement document cannot confirm the previous owner', async () => {
  const env = setup();
  env.replaceDocument();
  const report = await env.closeTab();
  expect(report.observed).toBe(true);
  expect(report.ok).toBe(false);
  expect(report.checkedFrames).toBe(0);
  expect(report.frames[0]!.documentIds).toEqual(['document-7-0']);
});

test('a manual close on YouTube completes without injecting into an unresponsive unrelated tab', async () => {
  const env = setup([frame()], [{ id: 99, url: 'https://github.com/', frames: [frame({ initialPip: false })] }]);
  env.stallTab(99);
  const report = await env.closeFromPopup();
  expect(report.ok).toBe(true);
  expect(report.scannedTabs).toBe(1);
  expect(env.injections.every((injection) => injection.tabId === 7)).toBe(true);
  expect((env.stored.autoPipLastManualClose as AutoPipGlobalCloseReport).ok).toBe(true);
});

test('an unresolved exit Promise cannot hide a successful native close or block the response', async () => {
  const env = setup([frame({ hangingExit: true })]);
  const report = await env.closeFromPopup();
  expect(report.ok).toBe(true);
  expect(report.reports[0].observed).toBe(true);
  expect(report.reports[0].frames[0].world).toBe('MAIN');
  expect(env.frames[0]!.inPip).toBe(false);
  expect(env.frames[0]!.exits).toBe(1);
});

test('a stalled MAIN API is reported as remaining PiP without waiting for its Promise', async () => {
  const env = setup([frame({ hangingExit: true, noOpExit: true })]);
  const report = await env.closeFromPopup();
  expect(report.ok).toBe(false);
  expect(report.reports[0].observed).toBe(true);
  expect(report.reports[0].remaining).toBe(true);
  expect(report.reports[0].frames[0].world).toBe('MAIN');
  expect(report.reports[0].errors).toContain('MAIN world で解除を呼びましたが、PiPがまだ開いています。');
  expect(report.reports[0].errors.some((error: string) => error.includes('PiP操作が応答'))).toBe(false);
});

test('overlapping activation and manual close share one native exit request', async () => {
  const env = setup([frame({ hangingExit: true, delayedExit: 25 })]);
  env.activate();
  const report = await env.closeFromPopup();
  expect(report.ok).toBe(true);
  expect(env.frames[0]!.exits).toBe(1);
  expect(env.frames[0]!.inPip).toBe(false);
});
